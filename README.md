# Chemclaw3 UI

A lightweight React chat frontend for [Chemclaw3](https://github.com/8fqycwdt8v-oss/Chemclaw3) — the
FastAPI agent service for pharmaceutical and chemical process R&D.

Two servers that talk to each other:

```
browser ──▶ chemclaw3-ui (Node)  ──▶ chemclaw3 (FastAPI)
            SPA + /api proxy          agent, tools, durable jobs
```

The browser never calls the FastAPI service directly. The UI server proxies `/api` to it
server-to-server, which means **no CORS configuration on the backend** and one place to attach the
bearer token.

## What it does

- **Streams a turn** and renders every event in the service's contract — tokens, plan revisions,
  tool calls, launched jobs, proposed notes, questions, approvals, and the final answer.
- **Shows the agent's work** in a collapsible trace panel. Honest about its limits: the service
  streams tool _invocations_ only, so the panel says what was called, never what came back.
- **Renders structures** from SMILES — the `molecule_smiles` a finished QM job pushes back, plus an
  opt-in toggle on inline SMILES in answers.
- **Surfaces verifier signals** — a "needs expert review" pill at the _top_ of a low-confidence
  answer, plus the confidence score and any unsupported claims.
- **Renders what a tool returned**, not only the model's paraphrase of it. The turn streams a
  200-character preview and a content address; a trace row offers to fetch the rest, and renders it
  as a hazard table, an ICH limit with its guideline, a charge table, or a generic table — with the
  result's own `verdict` above the data, because an empty screen is explicitly not a clearance.
- **Resolves citations.** A `note-…` chip opens the note with its provenance and its validity
  window, so a citation in an old answer that points at a superseded note says so.
- **Reviews machine-written knowledge.** `/review` is the PR gate in the browser: what a proposal
  would commit, byte for byte, and a decision that needs a reason to reject. `/jobs` is the durable
  run registry — searchable by _why_ each run was launched — with cancellation for those entitled.
- **Answers approvals.** A durable hold gets real Approve/Reject buttons wired to
  `POST /approvals/{id}/decision`; a plan approval posts to `POST /sessions/{id}/plan/decision`,
  bound to the hash of the plan that was actually shown. Both go through a confirmation: the
  decision is irreversible and attributable. Against a service that predates the plan route, the
  card falls back to answering in the conversation and says that is what it is doing.
- **Survives a reload** — conversations persist locally and rehydrate from the service.
- **Is ready for Entra SSO** without a rewrite: one env var switches the auth provider.

## Quick start

### Both servers with Docker Compose

Expects the Chemclaw3 checkout as a sibling directory (override with `CHEMCLAW_REPO`):

```sh
export ANTHROPIC_API_KEY=...        # or CHEMCLAW_LLM_PROVIDER=openai_compatible + OPENAI_API_KEY
ALLOW_INSECURE_AUTH=true docker compose up --build
open http://localhost:3000
```

This brings up Postgres/pgvector, Temporal, the Chemclaw3 service, and this UI. Only the UI
publishes a port — on `127.0.0.1` by default — and the backend stays on the internal network.

`ALLOW_INSECURE_AUTH=true` is not optional and is not a default this repository sets for you: the
stack runs `AUTH_MODE=dev`, which requires no sign-in and drives the backend as a shared principal
with every authorization gate open, and the BFF refuses to serve that on a non-loopback bind unless
somebody says it is deliberate. Share it beyond the host with `UI_BIND=0.0.0.0`, and allow it to be
framed (a preview iframe) with `ALLOW_FRAMING=true` — each one a separate decision.

### Against a locally-run backend

```sh
# in the Chemclaw3 repo
uvicorn service.app:create_app --factory --port 8080

# here
npm install
npm run dev            # UI on :5173, proxying through the BFF on :8787
```

`CHEMCLAW_API_URL` points the UI server at the service (default `http://127.0.0.1:8080`).

### Verifying the chain

```sh
npm run smoke                              # against the dev BFF
npm run smoke http://localhost:3000        # against the container
```

This is the check that matters: it asserts stream frames arrive **incrementally**. A stream that is
correct but arrives all at once means something in the chain is buffering, and nothing that only
inspects the final answer will catch it.

## Configuration

The UI server is configured entirely by environment — see [`.env.example`](.env.example). Because
Vite inlines `import.meta.env` at build time, browser-facing settings are served at runtime from
`GET /config.js` instead, so **one image runs in any tenant** with no rebuild.

### Enabling Entra SSO

The backend enforces Entra when `CHEMCLAW_ENTRA_REQUIRED=true`. Set `AUTH_MODE=msal` here at the
same time, plus:

| Variable          | Value                                                               |
| ----------------- | ------------------------------------------------------------------- |
| `ENTRA_TENANT_ID` | your tenant GUID                                                    |
| `ENTRA_CLIENT_ID` | **this SPA's** app registration (platform: Single-page application) |
| `API_SCOPE`       | `api://<api-client-id>/<scope>`, e.g. `.../Chat.Access`             |
| `REVIEWER_ROLES`  | the backend's `CHEMCLAW_ENTRA_PRIVILEGED_ROLES`, comma-separated    |

Three things account for most "the token looks fine but the API returns 401" incidents:

1. **The scope must be the API's.** Requesting only `openid`/`profile` yields an _ID_ token whose
   `aud` is the SPA client id; the backend checks `aud == CHEMCLAW_ENTRA_AUDIENCE`. Graph's
   `.default` is equally wrong.
2. **The API app registration needs `accessTokenAcceptedVersion: 2`.** The backend pins the issuer
   to `https://login.microsoftonline.com/{tenant}/v2.0`; a v1 token is issued by `sts.windows.net`
   and fails the issuer check.
3. **There is no `CHEMCLAW_ENTRA_CLIENT_ID` on the backend.** Its settings model is
   `extra="forbid"`, so exporting one aborts its startup. The SPA client id belongs only here.

Silent token refresh uses a hidden iframe to `login.microsoftonline.com`, so the CSP is built
conditionally on `AUTH_MODE` (`server/config.ts`). Copying the backend's `connect-src 'self'`
verbatim breaks refresh about an hour after login — a failure that looks like a random logout.

## Layout

```
server/     the BFF — route whitelist, streaming proxy, static host, /config.js
src/        the SPA — api/ auth/ state/ components/
  components/ui/    primitives (button, sheet, alert-dialog, …) on Radix + cva
  components/chem/  composites built from them (StatusDot, ConfirmDialog, …)
shared/     the event contract, mirrored from the service's api/events.py
scripts/    dev launcher, server bundler, smoke test, contrast gate
e2e/        Playwright specs and the SSE fixture service
public/     theme boot script, favicon — served as-is by the BFF
docs/       concept studies — what the chemistry surface is for, and what it still is not
```

Three files carry most of the difficulty and are commented accordingly:

- **`src/index.css`** — the design tokens, and one trap worth knowing before you add a
  theme-dependent one. **`@theme` cannot be nested to express a theme.** Tailwind v4 merges every
  `@theme` block into one map regardless of the at-rule around it, hoists the first into `:root` and
  deletes the rest, so last write wins unconditionally. This file used to carry a second `@theme`
  inside `@media (prefers-color-scheme: dark)`; it compiled to a single `:root` holding the _dark_
  values and no media query at all, and the app was dark in both OS modes. Anything theme-dependent
  is a plain custom property, and `@theme inline` maps the utility names onto it.

- **`server/proxy.ts`** — every SSE trap. Chiefly: it forces `accept-encoding: identity` (a
  compressed event stream buffers until the compressor's window fills), and it destroys the upstream
  request when the client disconnects. That last line is what makes **Stop** work: the service has
  no cancel endpoint, so propagating the disconnect is the only way it releases the session's turn
  lock — without it, the next message comes back 409.
- **`src/components/MessageList.tsx`** — `Bubble` is memoised because `updateAssistant` replaces
  the messages array every animation frame while returning the same object for messages it did not
  touch. Never give anything on this path a custom `areEqual`: one forgotten field and a streaming
  answer freezes mid-sentence, and no unit test catches it.

- **`src/state/chatStore.ts`** — the store keeps `streamedText` and `finalText` apart because
  `answer.text` is the _full concatenation_ of every token. Any code path that combined them would
  render the whole answer twice. There is deliberately none.

## Testing

```sh
npm test               # vitest — store, stream parsing, route whitelist, component contracts
npm run typecheck
npm run lint           # eslint — react-hooks/exhaustive-deps above all, plus jsx-a11y
npm run check:contrast # WCAG ratios for every token pair the UI composes, both themes
npm run test:e2e       # Playwright — layout, focus, keyboard, theme, mobile drawer
```

`check:contrast` converts OKLCH to sRGB rather than comparing lightness values: OKLCH's `L` is
perceptual and WCAG is defined on sRGB relative luminance, so two tokens that look far apart can
still fail. That gap is exactly how white-on-accent survived in dark mode at roughly 2:1.

`test:e2e` runs the real BFF against `e2e/fixture-service.ts`, which emits SSE frames with real
gaps between them. Stubbing the network inside the page would hand the whole body over at once and
pass against a chain that buffers end to end — the one failure this project most wants to catch.

Unit tests stub `fetch` with canned SSE bytes — no server is started. That is the only practical way
to exercise what a healthy backend will not produce on demand: frames split across chunk boundaries,
malformed frames, unknown event types, a stream that ends without an answer, and each of
401/404/409/422/429/503 mapping to the right typed error.

Everything else is verified against the real service.

## Delivery

GitHub Actions is the gate — typecheck, lint, format, unit tests, contrast, the three bundle-shape
checks, Playwright, and a container job. `Jenkinsfile` is the half it cannot do: publish the image
to a registry and roll it out. It does not re-run the gate (`RUN_GATE` is an opt-in for a
Jenkins-only estate), and it publishes **by digest** — a tag is a pointer, and a rollback that
follows one fetches bytes nobody reviewed.

Two checks there are deliberately _not_ copies of the GitHub job, because they run against the
**published image** rather than this workspace's `dist/`:

- **the bundle carries no dev auth provider** — the image builds its own bundle inside the
  Dockerfile with `ALLOW_DEV_AUTH` defaulting to false, so it is a different artifact from the one
  `npm run check:no-dev-auth` reads locally, and it is the one served to a chemist;
- **the container serves** `/healthz`, `/config.js`, the SPA fallback, and refuses `/api/metrics` —
  the proxy whitelist being the only thing between the browser and every route the BFF could
  otherwise forward.

This repository ships no chart, so a rollout is `oc set image` against a Deployment an operator
created. The four-repository release, its ordering (the UI last — it is useless before the API it
proxies answers) and the reasoning are in Chemclaw3: `deploy/jenkins/README.md` and
`D-2026-08-26-a-release-is-a-descriptor-and-a-target`.

## Backend requirements

The UI reads more of the service than it used to, and the degradation is deliberately split in two.
**List** routes — `GET /sessions`, `GET /sessions/{id}/messages`, `GET /approvals`,
`GET /proposals`, `GET /jobs` — swallow a 404 into an empty result, so an older service yields a
smaller app rather than a banner. **Fetch** routes — `GET /notes/{id}`,
`GET /sessions/{id}/tool-results/{ref}` — do not, because nothing calls them speculatively: the
control only exists when the turn said the thing exists, so a 404 there is a real fault.

`USER-STORIES.md` records which chemist-facing workflows this reaches and which it does not.

Conversation history also needs the service running with `CHEMCLAW_SESSION_STORE=postgres`. Under
the in-memory store there is nothing durable to list or read back.
