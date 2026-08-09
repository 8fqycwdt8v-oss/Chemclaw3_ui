"""Generate `shared/backend-contract.json` from a Chemclaw3 backend checkout.

This replaces the `check:openapi` script that `package.json` used to declare and that never
existed. It could not have existed as named: the backend sets `openapi_url=None` deliberately
(`chemclaw/api/app.py`) and pins it closed with a mutation-proof test, because the schema is a
plain route no dependency can gate and it exposed the whole surface unauthenticated. So there is
no spec to diff against, and the source of truth is the code.

What this emits is therefore a small, hand-shaped fixture rather than an OpenAPI document: the
route table, the SSE event union with each member's field set, and the closed enums. That is
exactly the surface a frontend can drift from, and every drift this repo actually shipped —
`job_failed` missing entirely, `answer.verified_by`, `tool_result.note_ids`/`numbers`, and
`error.code`/`retryable`/`correlation_id` all silently dropped — shows up as a diff in it.

The output is shaped to be READ in review. Fields render as one line each (`name: signature`),
sorted, so a backend reordering its model produces no diff and a genuinely new field produces one
line. `backend_revision` is recorded as provenance but is deliberately NOT asserted on by the
checker, or every backend commit would churn the fixture.

Usage:
    CHEMCLAW_REPO=/path/to/chemclaw3 python3 scripts/gen_backend_contract.py

Requires the backend's own environment (`uv sync` in that checkout), since it imports the app.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import typing
from pathlib import Path

REPO = Path(os.environ.get("CHEMCLAW_REPO", "/workspace/8fqycwdt8v-oss/chemclaw3")).resolve()
OUT = Path(__file__).resolve().parent.parent / "shared" / "backend-contract.json"

if not (REPO / "src" / "chemclaw").is_dir():
    sys.exit(f"gen_backend_contract: no chemclaw package under {REPO}. Set CHEMCLAW_REPO.")

sys.path.insert(0, str(REPO / "src"))

# `create_app` refuses to build an unauthenticated app on a non-loopback bind
# (`_refuse_unauthenticated_exposure`). Bind loopback so the refusal does not fire — we are only
# reading the route table, never serving.
os.environ.setdefault("CHEMCLAW_SERVICE_HOST", "127.0.0.1")
os.environ.setdefault("CHEMCLAW_ENTRA_REQUIRED", "false")

from fastapi.routing import APIRoute  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from chemclaw.api import events as events_mod  # noqa: E402
from chemclaw.api import schemas as schemas_mod  # noqa: E402
from chemclaw.api.app import create_app  # noqa: E402


def render_annotation(annotation: object) -> str:
    """A short, stable, human-readable spelling of a type annotation.

    Normalised rather than `repr`'d because the goal is a diff a reviewer can scan: `str | None`
    should not render as `typing.Optional[str]` in one Python version and `str | None` in the next.
    """
    origin = typing.get_origin(annotation)
    args = typing.get_args(annotation)

    if annotation is type(None):
        return "None"
    if origin is typing.Literal:
        return "Literal[" + ", ".join(repr(a) for a in args) + "]"
    if origin is typing.Union or str(origin) == "<class 'types.UnionType'>":
        return " | ".join(render_annotation(a) for a in args)
    if origin in (list, set, tuple, frozenset):
        inner = ", ".join(render_annotation(a) for a in args)
        return f"{origin.__name__}[{inner}]"
    if origin is dict:
        inner = ", ".join(render_annotation(a) for a in args)
        return f"dict[{inner}]"
    if isinstance(annotation, type):
        return annotation.__name__
    return str(annotation).replace("typing.", "")


def render_fields(model: type[BaseModel]) -> dict[str, str]:
    """`{field: "type = default"}`, alphabetically — one reviewable line per field."""
    out: dict[str, str] = {}
    for name, field in sorted(model.model_fields.items()):
        sig = render_annotation(field.annotation)
        if not field.is_required():
            default = field.default
            # A default_factory has no stable repr; name the shape instead of the object.
            if default is None and field.default_factory is not None:
                produced = field.default_factory()  # type: ignore[call-arg]
                default = produced
            sig += f" = {default!r}"
        out[name] = sig
    return out


def collect_routes(app: object) -> tuple[list[dict[str, object]], list[str]]:
    """The gateable route table, plus the non-APIRoute surfaces (mounts, static)."""
    routes: list[dict[str, object]] = []
    ungatable: list[str] = []
    for route in app.routes:  # type: ignore[attr-defined]
        if isinstance(route, APIRoute):
            methods = sorted(set(route.methods or set()) - {"HEAD", "OPTIONS"})
            routes.append({"path": route.path, "methods": methods})
        else:
            ungatable.append(f"{type(route).__name__} {getattr(route, 'path', '')}")
    routes.sort(key=lambda r: (r["path"], ",".join(r["methods"])))  # type: ignore[arg-type]
    return routes, sorted(ungatable)


def collect_events() -> dict[str, dict[str, object]]:
    """Each SSE event, keyed by its `type` discriminator."""
    members = typing.get_args(events_mod.Event)
    out: dict[str, dict[str, object]] = {}
    for model in members:
        discriminator = typing.get_args(model.model_fields["type"].annotation)[0]
        out[discriminator] = {"model": model.__name__, "fields": render_fields(model)}
    return dict(sorted(out.items()))


def collect_schemas() -> dict[str, dict[str, str]]:
    """The request/response models, so a client type can be diffed against them."""
    out: dict[str, dict[str, str]] = {}
    for name, obj in vars(schemas_mod).items():
        if (
            isinstance(obj, type)
            and issubclass(obj, BaseModel)
            and obj is not BaseModel
            and obj.__module__ == schemas_mod.__name__
        ):
            out[name] = render_fields(obj)
    return dict(sorted(out.items()))


def backend_revision() -> str:
    try:
        return subprocess.run(
            ["git", "-C", str(REPO), "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except Exception:  # provenance is nice to have, never worth failing over
        return "unknown"


def main() -> None:
    app = create_app(agent_factory=lambda _profile: object())
    routes, ungatable = collect_routes(app)

    contract = {
        "_comment": (
            "Generated by scripts/gen_backend_contract.py from a Chemclaw3 checkout. Do not edit "
            "by hand. A change here is a backend contract change: review it, then update the "
            "frontend to match. Checked by scripts/check-contract.mjs."
        ),
        "backend_revision": backend_revision(),
        "routes": routes,
        "ungatable_surfaces": ungatable,
        "events": collect_events(),
        "enums": {
            "ErrorCode": list(typing.get_args(events_mod.ErrorCode)),
        },
        "schemas": collect_schemas(),
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(contract, indent=2, sort_keys=False) + "\n")
    print(f"wrote {OUT} ({len(routes)} routes, {len(contract['events'])} events)")


if __name__ == "__main__":
    main()
