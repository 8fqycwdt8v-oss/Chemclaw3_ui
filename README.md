# Chemclaw3 UI

A React chat frontend for [Chemclaw3](https://github.com/8fqycwdt8v-oss/Chemclaw3), the FastAPI
agent service for pharmaceutical and chemical process R&D.

```
browser ──▶ chemclaw3-ui (Node BFF)  ──▶ chemclaw3 (FastAPI)
            SPA + /api proxy              agent, tools, durable jobs
```

The browser never calls the service directly. The BFF proxies a whitelist of `/api` routes
server-to-server, so the backend needs no CORS and there is one place the bearer token passes.

Operators: building, configuring, deploying, verifying and troubleshooting are in
[`docs/operations.md`](docs/operations.md). What is enforced, bounded and accepted is in
[`docs/production-readiness.md`](docs/production-readiness.md); open items in
[`ISSUES.md`](ISSUES.md).

## What it does

- **Streams a turn** and renders every event in the service's contract (`shared/events.ts`):
  tokens, plan revisions, tool calls, jobs, notes, questions, approvals and the final answer, with
  a one-line activity row that becomes the turn's summary when it settles.
- **Shows the agent's work** as a step rail; a refused call is shown as _held_, not failed.
- **Renders structures** with RDKit (in a worker) and accepts them by SMILES, `.mol`/`.sdf` drop or
  the Ketcher sketcher.
- **Renders tool results in the answer** through a shape-keyed registry (`src/results/`): hazard
  tables, ICH limits, charge tables, structure grids, series, generic tables — with the result's
  own verdict above the data.
- **Experiment protocols** (`/protocols`) are editable documents; a save is a new revision bound to
  the revision it was written on, so concurrent edits get a refusal and a re-read.
- **Artefacts** (code name `exhibit`): versioned working documents in a right-hand pane, editable by
  the chemist, exportable, listed at `/artefacts`. Off when the service has
  `agent_exhibits_enabled` off.
- **Citations** resolve to notes with provenance and validity window.
- **`/review`** lists plans awaiting a decision and held-open questions across conversations;
  **`/jobs`** is the durable run registry. A plan decision posts to
  `POST /sessions/{id}/plan/decision`, bound to the hash of the plan shown.
- **Shared conversations**: an owner adds members; each message runs as its sender, only a plan's
  author can decide it, and members follow each other's turns live.
- **Entra SSO** (auth code + PKCE in the browser) with `AUTH_MODE=msal`, switched at runtime.

## Quick start

Node **22.12 or newer**.

**Both servers with Docker Compose** (Chemclaw3 checked out as a sibling, or `CHEMCLAW_REPO`):

```sh
export CHEMCLAW_LLM_BASE_URL=https://<gateway>/v1   # any OpenAI-compatible /v1 base
export CHEMCLAW_LLM_MODEL=...
export CHEMCLAW_LLM_API_KEY=...
ALLOW_DEV_AUTH=true ALLOW_INSECURE_AUTH=true docker compose up --build
open http://localhost:3000
```

`ALLOW_DEV_AUTH=true` compiles the no-sign-in dev provider into the image (without it the page
refuses `AUTH_MODE=dev`); `ALLOW_INSECURE_AUTH=true` lets the BFF serve dev auth on a non-loopback
bind. The UI publishes on `127.0.0.1` only; `UI_BIND=0.0.0.0` shares it.

**Against a locally-run backend:**

```sh
# in Chemclaw3
uvicorn chemclaw.api.app:create_app --factory --port 8080
# here
npm ci
npm run dev            # Vite on 127.0.0.1:5173, BFF on :8787, sandbox on :8788
```

Open `http://127.0.0.1:5173` exactly (it is the sandbox's `APP_ORIGIN`). `CHEMCLAW_API_URL`
overrides the backend address (default `http://127.0.0.1:8080`).

`npm run smoke [base-url]` checks that stream frames arrive **incrementally** through the chain —
a buffered stream is correct but arrives all at once.

## Configuration

All configuration is environment, tabled in [`docs/operations.md`](docs/operations.md) §3.
Browser-facing values are served at runtime by `GET /config.js`, so one image runs in any tenant.

### What the BFF refuses to start with

`validateConfig` (`server/config.ts`) logs one `config:` line per problem and exits 1 for:

- `CHEMCLAW_API_URL` not an http(s) URL, or carrying a path (put a prefix in the ingress);
- `AUTH_MODE` other than `dev` or `msal`;
- `MAX_MESSAGE_CHARS` not a whole number above zero;
- under `msal`: missing `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID` or `API_SCOPE`; an `ENTRA_AUTHORITY`
  that is not an https URL or carries a query, fragment or userinfo;
- `AUTH_MODE=dev` on a non-loopback `BIND_HOST` without `ALLOW_INSECURE_AUTH=true`;
- sandbox settings that are not plain http(s) origins, `SANDBOX_ORIGIN` without or equal to
  `APP_ORIGIN`, an http sandbox under an https app, `SANDBOX_PORT` outside 1–65535 or equal to
  `PORT` while the sandbox is on, `HTML_SCRIPTS_DEFAULT` other than `on`/`off`;
- `DOCS_BASE_URL` neither an http(s) URL nor a path on this origin.

A listener that cannot bind exits 1 with one line naming the address.

### Enabling Entra SSO

Set `AUTH_MODE=msal` when the backend has `CHEMCLAW_ENTRA_REQUIRED=true`, plus:

| Variable          | Value                                                                      |
| ----------------- | -------------------------------------------------------------------------- |
| `ENTRA_TENANT_ID` | tenant GUID                                                                |
| `ENTRA_CLIENT_ID` | **this SPA's** app registration (platform: Single-page application)        |
| `API_SCOPE`       | `api://<api-client-id>/<scope>`                                            |
| `REVIEWER_ROLES`  | the backend's `CHEMCLAW_ENTRA_PRIVILEGED_ROLES`, comma-separated           |
| `ENTRA_AUTHORITY` | optional; default `https://login.microsoftonline.com/<tenant>`; https only |

The usual causes of "token looks fine, API returns 401": the scope is not the API's (an ID token's
`aud` is the SPA); the API registration does not issue v2 tokens (`accessTokenAcceptedVersion: 2`);
or `CHEMCLAW_ENTRA_AUDIENCE` does not match. The backend has no `CHEMCLAW_ENTRA_CLIENT_ID`.

The CSP depends on `AUTH_MODE`: silent refresh needs a hidden iframe to the authority, so
`connect-src`, `frame-src` and `form-action` open the authority's origin. A non-default
`ENTRA_AUTHORITY` (sovereign cloud, Chemclaw3_mock's tenant) replaces `login.microsoftonline.com`
there.

The RDKit worker script (`/assets/rdkit.worker-<hash>.js`) is served with `RDKIT_WORKER_CSP`, the
only policy containing `'unsafe-eval'` (Embind needs `Function(...)`). A proxy or CDN must pass
per-path CSP headers through, or no structure is drawn.

### HTML sandbox (artefacts)

An `html` artefact is markup and script the agent wrote. It never runs on the app's origin: the
BFF's **second listener** serves `GET /sandbox/frame` (and nothing else) on a different origin,
under `default-src 'none'; connect-src 'none'` and `frame-ancestors <APP_ORIGIN>`, embedded with
`sandbox="allow-scripts"` only. The app listener answers that path 404. The shell posts
`{type: "ready"}`, receives the artefact from `APP_ORIGIN` only, and posts back only its height.

**Scripts run by default.** The view says so and offers **Disable scripts** (not persisted).
`HTML_SCRIPTS_DEFAULT=off` is the kill switch: nothing runs until someone presses **Run scripts**.

What a running script can still do (accepted risk, `ISSUES.md` Issue 25): send data over WebRTC
(CSP does not govern it; the prelude that removes the constructors is bypassable), including
anything typed into the artefact, and write the clipboard after a click. Browser policy narrows it:
Chrome/Edge `WebRtcIPHandling=disable_non_proxied_udp`, Firefox `media.peerconnection.enabled=false`.
It cannot navigate anywhere else (`e2e/sandbox.spec.ts`).

If no `ready` arrives within `SANDBOX_READY_TIMEOUT_MS` (`shared/sandbox.ts`), the view shows the
source with "The sandbox did not answer". The help link resolves this section against
`DOCS_BASE_URL`. **Export** saves the source as `<title>.html.txt`.

| Variable               | Value                                                                       |
| ---------------------- | --------------------------------------------------------------------------- |
| `SANDBOX_ORIGIN`       | origin the browser reaches the sandbox at; unset = sandbox off              |
| `APP_ORIGIN`           | origin the browser reaches the app at; required with `SANDBOX_ORIGIN`       |
| `SANDBOX_PORT`         | second listener's port (default `8081`), not `PORT`                         |
| `SANDBOX_BIND_HOST`    | its bind address (default `BIND_HOST`)                                      |
| `HTML_SCRIPTS_DEFAULT` | `on` (default) or `off`                                                     |
| `DOCS_BASE_URL`        | where the app links to this README (default: this repository on github.com) |

Both origins are what the browser types, exactly; at any other address the artefact is shown as
escaped source with a notice naming both. Unset `SANDBOX_ORIGIN` (or `ALLOW_FRAMING=true`, which
turns the sandbox off) shows HTML as source. One startup line says `html sandbox on: …` or
`html sandbox off: <reason>`.

| How you run it                 | App                      | Sandbox                                       |
| ------------------------------ | ------------------------ | --------------------------------------------- |
| `docker compose up`            | `http://localhost:3000`  | `http://localhost:3001`                       |
| `npm run dev`                  | `http://127.0.0.1:5173`  | `http://127.0.0.1:8788`                       |
| the browser suite              | `http://127.0.0.1:4321`  | `http://127.0.0.1:4323` (kill switch: 4324/5) |
| kind (Chemclaw3 `deploy/kind`) | `http://127.0.0.1:15173` | `http://sandbox.localhost:15174`              |
| `start.sh` (hosted preview)    | the platform's           | off — no reliable second public port to use   |

In a deployment the sandbox needs its own Route and host (edge TLS, no SSO in front, CSP passed
through untouched, ideally a separate registrable domain); see
[`deploy/openshift/`](deploy/openshift/README.md).

## Layout

```
server/   the BFF — route whitelist, streaming proxy, static host, /config.js, access log,
          /metrics, /readyz, the browser log sink, the sandbox listener
src/      the SPA — api/ auth/ state/ hooks/ chem/ components/ results/ lib/
shared/   imported by SPA and BFF: contracts hand-mirrored from the service (events.ts,
          protocols.ts, exhibits.ts) and constants both sides must agree on
scripts/  the gate (ci.mjs) and its checks, dev launcher, server bundler, smoke test
tests/    vitest unit tests
e2e/      Playwright specs and the SSE fixture service
public/   theme boot script, favicon
deploy/   example OpenShift manifests (not a chart)
docs/     operations, production-readiness record, dependency record
```

## Testing

```sh
npm run ci             # the whole gate — what both pipelines run (scripts/ci.mjs)
npm run ci -- --list   # its steps
npm run ci:container   # build the image and assert it serves (skips without Docker)
npm test               # vitest
npm run typecheck
npm run lint
npm run test:e2e       # Playwright against the real BFF and e2e/fixture-service.ts
npm run test:e2e:oidc-mock   # real MSAL sign-in against Chemclaw3_mock (CI's oidc-mock job)
npm run check:live     # smoke + check:openapi; needs a live service, operator-run
```

`test:e2e:full-stack` and `test:e2e:kind` need the whole four-repository system already up.

The e2e fixture emits SSE frames with real gaps, through the real BFF, so a buffering chain fails.
`tests/backendContract.test.ts` checks routes, request bodies, events and response fields against a
Chemclaw3 checkout (`CHEMCLAW3_DIR`, then `CHEMCLAW_REPO`, else `../Chemclaw3`); with no checkout it
warns, and `CHEMCLAW3_REQUIRED=1` makes that a failure.

## Delivery

GitHub Actions runs `npm run ci` on pushes to `main`, on pull requests, and on manual dispatch. `Jenkinsfile` publishes the image **by digest** and
rolls it out with `oc set image`; it re-runs the gate only when `RUN_GATE` is set. The four-repo
release order (UI last) is in Chemclaw3's `deploy/jenkins/README.md`.

## Backend requirements

List routes (`GET /sessions`, `/sessions/{id}/messages`, `/jobs`, `/protocols`, `/exhibits`) fold a
404 into an empty result, so an older service yields a smaller app; fetch routes for a specific
item do not. Conversation history needs `CHEMCLAW_SESSION_STORE=postgres`. Every backend setting
the UI depends on is in [`docs/operations.md`](docs/operations.md) §4.
