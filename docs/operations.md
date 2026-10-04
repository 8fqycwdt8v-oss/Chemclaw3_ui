# Operating the UI — build, configure, deploy, verify, troubleshoot

The operator's path through `Chemclaw3_ui`, end to end. [`README.md`](../README.md) says what the
UI does and argues its design; this file says how to run it. Where the README already carries the
full reasoning (the HTML sandbox, Entra), this file states the steps and links there.

Every default below is the one `server/config.ts` resolves (or the file named beside it). Where this
file and the code disagree, the code is right and this file is the bug.

---

## 1. What runs

One Node process, the **BFF** (`server/`, bundled to `dist/server.js`):

- serves the built SPA (`dist/client`) and `GET /config.js` — the browser's runtime configuration,
  rendered from this process's environment on every request, so **one image runs in any tenant**;
- proxies a **whitelist** of `/api/*` routes (`server/routes.ts`) to the Chemclaw3 FastAPI service
  at `CHEMCLAW_API_URL`, stripping the `/api` prefix — the browser never talks to the backend, so
  the backend needs **no CORS** (`CHEMCLAW_SERVICE_CORS_ORIGINS` stays empty) and is never exposed;
- answers its own `GET /healthz`, `GET /readyz`, `GET /metrics` and `POST /api/client-events`;
- runs a **second listener** on `SANDBOX_PORT` (default 8081) that serves `GET /sandbox/frame` and
  nothing else, when the HTML sandbox is configured (README, "HTML sandbox (artefacts)").

The bearer token travels browser → BFF → service verbatim in `Authorization`; the BFF holds no
credential of its own and needs no Secret. `cookie`, `proxy-authorization`, `x-chemclaw-*` and the
`x-forwarded-*` family are dropped on the way upstream.

---

## 2. Build

Node **22.12 or newer** (`engines` in `package.json`; the Dockerfile and CI use `node:22`).

```sh
npm ci
npm run build          # vite build -> dist/client (+ .gz/.br siblings), esbuild -> dist/server.js
npm start              # node dist/server.js — needs no node_modules at runtime
```

`dist/server.js` inlines everything it imports, so the runtime image carries `dist/` and nothing
else (`npm run check:standalone` proves it).

**The image:**

```sh
docker build -t chemclaw3-ui .                            # production: no dev auth in the bundle
docker build --build-arg ALLOW_DEV_AUTH=true -t ui-dev .  # only for an AUTH_MODE=dev deployment
```

`ALLOW_DEV_AUTH` is a **build** argument, not runtime configuration: it decides whether the no-token
dev auth provider is compiled into the client bundle at all. Default `false`. An image built without
it and run with `AUTH_MODE=dev` boots, serves `/healthz`, and then every page shows "AUTH_MODE=dev
is not permitted in this production build" — which is the intended refusal, not a bug.
`npm run check:no-dev-auth` asserts a `dist/client` carries no dev provider.

The image runs as the non-root `node` user, listens on 8080 (and 8081 for the sandbox), and its
`HEALTHCHECK` reads `/healthz`.

---

## 3. Configuration

All runtime configuration is environment. A value the BFF cannot use is **refused at boot** — one
`config: …` line per problem on stdout and exit 1 — rather than served half-working; the README's
"What the BFF refuses to start with" lists every refusal.

### Connecting to Chemclaw3

| Variable            | Default                 | Required          | Meaning                                                                                                                                                                                   |
| ------------------- | ----------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHEMCLAW_API_URL`  | `http://127.0.0.1:8080` | yes, in practice  | The Chemclaw3 service **root**, http(s). A path (`https://gw/chemclaw`) is refused — put a prefix in the ingress. In-cluster this is the chart's Service: `http://chemclaw-service:8080`. |
| `MAX_MESSAGE_CHARS` | `100000`                | match the backend | Must equal the backend's `CHEMCLAW_SERVICE_MAX_MESSAGE_CHARS`. A whole number above 0, else refused.                                                                                      |
| `REVIEWER_ROLES`    | empty                   | under `msal`      | Comma-separated app roles; must equal the backend's `CHEMCLAW_ENTRA_PRIVILEGED_ROLES`. Only hides controls that would 403 — the backend enforces. Ignored under `dev`.                    |
| `WARM_SESSIONS`     | `true`                  | no                | Create the backend session on the first keystroke so the first send is one round trip. Each conversation typed into costs the service one live-session slot. `false` turns it off.        |
| `SHARED_POLL_MS`    | `5000`                  | no                | How often an open shared conversation reads `GET /sessions/{id}/queue`. Whole ms, at least 250, else refused.                                                                             |

### Sign-in

| Variable              | Default                                      | Required     | Meaning                                                                                                                                          |
| --------------------- | -------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AUTH_MODE`           | `dev`                                        | yes          | `msal` (Entra SSO, auth code + PKCE in the browser) or `dev` (no `Authorization` header). Anything else is refused.                              |
| `ENTRA_TENANT_ID`     | empty                                        | under `msal` | Tenant GUID.                                                                                                                                     |
| `ENTRA_CLIENT_ID`     | empty                                        | under `msal` | **This SPA's** app registration (platform: Single-page application). Never set on the backend — it has no such setting and refuses unknown ones. |
| `API_SCOPE`           | empty                                        | under `msal` | `api://<api-client-id>/<scope>`, e.g. `…/Chat.Access`.                                                                                           |
| `ENTRA_AUTHORITY`     | `https://login.microsoftonline.com/<tenant>` | no           | A sovereign cloud or a test tenant. https only; its origin replaces Entra's in the CSP.                                                          |
| `ALLOW_INSECURE_AUTH` | `false`                                      | no           | Permits `AUTH_MODE=dev` on a non-loopback `BIND_HOST`. Never in a shared deployment.                                                             |

### Listeners and the HTML sandbox

| Variable               | Default                                                     | Meaning                                                                                                          |
| ---------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `PORT`                 | `8080`                                                      | The app listener. (`start.sh` defaults it to 8099; `npm run dev` runs the BFF on `BFF_PORT`, 8787.)              |
| `BIND_HOST`            | `0.0.0.0`                                                   | The app listener's address.                                                                                      |
| `CLIENT_DIR`           | `client` beside the server bundle (`dist/client`)           | Where the built SPA is read from. The image sets `/app/dist/client`.                                             |
| `SANDBOX_ORIGIN`       | unset (sandbox off)                                         | The origin the **browser** reaches the sandbox at, exactly. Unset: HTML artefacts are shown as source.           |
| `APP_ORIGIN`           | unset                                                       | The origin the **browser** reaches the app at, exactly. Required with `SANDBOX_ORIGIN`, and must differ from it. |
| `SANDBOX_PORT`         | `8081`                                                      | The sandbox listener's port; 1–65535 (always checked), not `PORT`.                                               |
| `SANDBOX_BIND_HOST`    | `BIND_HOST`                                                 | The sandbox listener's address.                                                                                  |
| `HTML_SCRIPTS_DEFAULT` | `on`                                                        | Whether an HTML artefact's script runs without a click. `off` is the kill switch.                                |
| `ALLOW_FRAMING`        | `false`                                                     | Lets any origin frame the app (a preview host). Also turns the sandbox **off**.                                  |
| `DOCS_BASE_URL`        | `https://github.com/8fqycwdt8v-oss/Chemclaw3_ui/blob/main/` | Where the app links to the README; point it at an internal mirror when air-gapped.                               |

### Logging

| Variable           | Default | Meaning                                                                                                             |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`        | `info`  | This process. Anything but `debug` is one JSON object per line, in the backend's field names, so the two logs join. |
| `CLIENT_LOG_LEVEL` | `info`  | What every browser records (`silent`…`debug`), served through `/config.js`. One browser: append `?debug=1`.         |
| `APP_VERSION`      | `dev`   | Stamped on the startup line and served to the SPA.                                                                  |

### Limits and timeouts

The defaults are sized for 200 chemists per pod; [`.env.example`](../.env.example) carries the
measurement behind each.

| Variable                      | Default    | Bounds                                                                                           |
| ----------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| `SSE_HEARTBEAT_MS`            | `15000`    | Comment frame on an idle SSE stream, so an intermediary's idle timeout never fires. 0 = off.     |
| `UPSTREAM_CONNECT_TIMEOUT_MS` | `10000`    | Connecting to the backend.                                                                       |
| `UPSTREAM_HEADERS_TIMEOUT_MS` | `120000`   | Backend's time to the first response header (not the body; a 600 s turn is unaffected). 0 = off. |
| `REQUEST_TIMEOUT_MS`          | `130000`   | A client's time to send a whole request (a 32 MB upload on a slow link).                         |
| `HEADERS_TIMEOUT_MS`          | `30000`    | A client's time to send request headers; clamped to `REQUEST_TIMEOUT_MS`.                        |
| `MAX_CONNECTIONS`             | `1024`     | Client connections held at once; the surplus is dropped without a response.                      |
| `MAX_UPSTREAM_SOCKETS`        | `512`      | Upstream sockets for ordinary calls.                                                             |
| `MAX_UPSTREAM_STREAM_SOCKETS` | `1024`     | Upstream sockets for SSE (one per turn and per job stream).                                      |
| `UPSTREAM_QUEUE_TIMEOUT_MS`   | `10000`    | Wait for a free upstream socket before answering 503 `EPOOLTIMEOUT`.                             |
| `MAX_BODY_BYTES`              | `2097152`  | Largest request body forwarded (413 above it).                                                   |
| `MAX_UPLOAD_BYTES`            | `33554432` | Largest attachment upload forwarded.                                                             |
| `CLIENT_EVENTS_RATE_PER_MIN`  | `3000`     | Browser log batches this pod accepts per minute on `/api/client-events`; the rest get 429.       |
| `SHUTDOWN_DRAIN_MS`           | `10000`    | On SIGTERM, how long `/readyz` answers 503 before the listener closes (then 5 s grace).          |

### Build-time and development only

| Variable                                                                                                                    | Read by                                         | Meaning                                                                               |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `ALLOW_DEV_AUTH`                                                                                                            | `vite.config.ts`, Dockerfile ARG                | `true` compiles the dev auth provider into the bundle. Default `false`.               |
| `CLIENT_OUT_DIR`                                                                                                            | `vite.config.ts`, `scripts/compress-assets.mjs` | Where `vite build` writes; default `dist/client`.                                     |
| `BFF_PORT`                                                                                                                  | `scripts/dev.mjs`, `vite.config.ts`             | The dev BFF's port (8787) that Vite proxies `/api` and `/config.js` to.               |
| `VITE_AUTH_MODE`, `VITE_ENTRA_TENANT_ID`, `VITE_ENTRA_CLIENT_ID`, `VITE_ENTRA_AUTHORITY`, `VITE_API_SCOPE`, `VITE_API_BASE` | `src/env.ts`                                    | Fallbacks for a bare `vite dev` with no BFF; `/config.js` wins whenever it is served. |

---

## 4. Deploy to OpenShift

This repository ships **no chart**. [`deploy/openshift/`](../deploy/openshift/README.md) holds an
example Deployment, Service and two Routes, held to `server/config.ts` by
`tests/openshiftManifests.test.ts`. The release model is: an operator applies those once; every
later release is Jenkins re-pointing the Deployment by digest
(`oc set image deployment/chemclaw3-ui ui=<registry>/<image>@sha256:…`).

1. **Deploy Chemclaw3 first** (its Helm chart). The UI is useless before the API it proxies
   answers; the four-repository release order is Chemclaw3's `deploy/jenkins/README.md`.
2. **Register the SPA in Entra** (platform: Single-page application, redirect URI
   `https://<app host>/auth/callback`), and make sure the API's registration issues **v2** tokens
   (`accessTokenAcceptedVersion: 2`) and exposes the scope you put in `API_SCOPE`. Give the users
   the app roles named in `REVIEWER_ROLES`.
3. **Copy and edit `deploy/openshift/`**: the two hosts (Routes) and the two origins
   (`APP_ORIGIN`/`SANDBOX_ORIGIN` = `https://` + those hosts, exactly), the tenant, client id and
   scope, `REVIEWER_ROLES`, and the image. `CHEMCLAW_API_URL` is `http://chemclaw-service:8080`
   when the chart is installed under its default name in the same namespace
   (`http://chemclaw-service.<ns>.svc:8080` from another). None of the values is secret, so plain
   `env` (or a ConfigMap) is enough — there is no Secret to create.
4. `oc apply -n <ns> -f deploy/openshift/`.
5. **Point Jenkins at it**: `DEPLOY_TARGET=openshift`, `NAMESPACE`, `DEPLOYMENT=chemclaw3-ui`,
   `IMAGE_REGISTRY`, `CLUSTER_API`, the two credential ids, and `DRY_RUN=false`. The pipeline
   refuses to deploy without a registry digest.

**What the backend must be configured with for this UI** (Chemclaw3 settings, `CHEMCLAW_` prefix):

| Backend setting                                       | Value                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `CHEMCLAW_ENTRA_REQUIRED`                             | `true` with `AUTH_MODE=msal` (otherwise the UI's readiness fails — §6).         |
| `CHEMCLAW_ENTRA_TENANT_ID`, `CHEMCLAW_ENTRA_AUDIENCE` | the tenant, and the `aud` the API's tokens carry.                               |
| `CHEMCLAW_ENTRA_ISSUER` / `CHEMCLAW_ENTRA_JWKS_URL`   | only when `ENTRA_AUTHORITY` is not Entra's public cloud.                        |
| `CHEMCLAW_ENTRA_PRIVILEGED_ROLES`                     | the same list as the UI's `REVIEWER_ROLES`.                                     |
| `CHEMCLAW_SERVICE_MAX_MESSAGE_CHARS`                  | the same number as the UI's `MAX_MESSAGE_CHARS`.                                |
| `CHEMCLAW_SESSION_STORE=postgres`                     | conversation history, the sidebar listing and reattach after a restart need it. |
| `CHEMCLAW_SERVICE_CORS_ORIGINS`                       | empty — the browser never calls the backend.                                    |

**Two backend properties a UI operator should know about:**

- **The backend caps live event streams** — `CHEMCLAW_SERVICE_MAX_EVENT_STREAMS_TOTAL` per backend
  process (default 200) and `CHEMCLAW_SERVICE_MAX_EVENT_STREAMS_PER_USER` (default 5) — and answers
  429 over either, which the SPA backs off from. The UI's own stream pool
  (`MAX_UPSTREAM_STREAM_SOCKETS`, 1024) is sized for 200 chemists × 4 streams, so at that load the
  backend's per-process cap binds first: scale the backend, not only the UI.
- **Uploaded attachments live in one backend pod's memory** (Chemclaw3
  `chemclaw/agent/attachments.py`), and the chart's Route uses a cookie for affinity for that
  reason. The BFF reaches the backend through its Service, not its Route, so that cookie does not
  apply. With more than one backend replica, a file uploaded on one pod may not be visible to a
  turn served by another. Until attachments have a durable home upstream, either run the backend
  at one replica when attachments matter, or accept that the agent may not see an upload.

---

## 5. Run it locally against a local Chemclaw3

**Both servers in Docker** (Chemclaw3 checked out beside this repo, or `CHEMCLAW_REPO=<path>`):

```sh
export CHEMCLAW_LLM_BASE_URL=https://<gateway>/v1  CHEMCLAW_LLM_MODEL=<model>  CHEMCLAW_LLM_API_KEY=<key>
ALLOW_DEV_AUTH=true ALLOW_INSECURE_AUTH=true docker compose up --build
open http://localhost:3000          # the sandbox is http://localhost:3001
```

`ALLOW_DEV_AUTH=true` builds the dev auth provider into the UI image (the stack runs
`AUTH_MODE=dev`); `ALLOW_INSECURE_AUTH=true` is the BFF's opt-in for serving it on the container's
`0.0.0.0` bind. The UI is published on `127.0.0.1` only (`UI_BIND=0.0.0.0` to share it).

**The backend on the host, the UI in dev mode:**

```sh
# in Chemclaw3 — see its docs/guides/runbook.md for the database, Temporal and model gateway
make up && make db-migrate
uvicorn chemclaw.api.app:create_app --factory --port 8080

# here
npm ci
npm run dev        # Vite on http://127.0.0.1:5173, BFF on :8787, sandbox on :8788
```

Open **`http://127.0.0.1:5173`** exactly — the sandbox's `APP_ORIGIN` is that string, and
`localhost:5173` is a different origin (HTML artefacts would show as source). `CHEMCLAW_API_URL`
overrides the backend address (default `http://127.0.0.1:8080`). The backend must run with
`CHEMCLAW_ENTRA_REQUIRED=false` (its default) for dev auth.

Chemclaw3's four-repository lanes start this UI themselves: `make live-e2e-full-stack` runs
`npm run dev` here against a front door on `127.0.0.1:8000`, and `make kind-up` deploys the UI
image to a kind cluster at `http://127.0.0.1:15173`.

`./start.sh` is for a hosted preview (Replit): it builds the client if missing, defaults
`CHEMCLAW_API_URL` to `http://127.0.0.1:8000` and `PORT` to 8099, and leaves the sandbox off.

---

## 6. Verify

| Check                     | Command / URL                                            | Good answer                                                                    |
| ------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| process up (liveness)     | `GET /healthz`                                           | `200 {"status":"ok"}` — never consults the backend                             |
| can serve (readiness)     | `GET /readyz`                                            | `200 {"status":"ready","upstream_status":200}`                                 |
| tenant config             | `GET /config.js`                                         | `window.__CHEMCLAW_CONFIG__={…}` with your `authMode`, tenant, `sandboxOrigin` |
| sandbox listener          | `GET https://<sandbox host>/sandbox/frame`               | 200 with its own CSP; `GET https://<app host>/sandbox/frame` is 404            |
| whitelist                 | `GET /api/metrics`                                       | 404 (never forwarded)                                                          |
| the image's four promises | `npm run check:serving -- https://<app host>`            | four ✓                                                                         |
| a real streamed turn      | `ACCESS_TOKEN=<bearer> npm run smoke https://<app host>` | frames arrive **incrementally**; omit `ACCESS_TOKEN` under `dev`               |
| wire contract vs backend  | `npm run check:openapi <backend url>`                    | needs the backend reachable directly                                           |

The startup log says what the process decided: one `listening` line (upstream, auth mode, version)
and one `html sandbox on: …` or `html sandbox off: <reason>` line. `GET /metrics` exposes
`chemclaw_ui_requests_total`, `chemclaw_ui_request_duration_seconds`,
`chemclaw_ui_requests_in_flight` and `chemclaw_ui_upstream_errors_total`, labelled by route
pattern only.

---

## 7. Troubleshoot

**The pod exits at once.** Read the `config: …` lines — each names the variable and why it was
refused. `EADDRINUSE` on `PORT` or `SANDBOX_PORT` is one structured line naming the address.

**`/readyz` is 503.** Its body says why:

- `"detail":"upstream unreachable"`, `upstream_status: 0` — `CHEMCLAW_API_URL` is wrong, the
  Service name or port is wrong, or a NetworkPolicy blocks UI → backend.
- `"detail":"upstream not ready"` — the backend's own `/readyz` is failing; look there.
- `"detail":"upstream accepts anonymous"` — the UI runs `AUTH_MODE=msal` and the backend answered
  an anonymous `GET /sessions`. The backend has `CHEMCLAW_ENTRA_REQUIRED=false`; set it true. This
  is deliberate: a signed-in front end over an open backend is refused.
- `"detail":"draining"` — the pod received SIGTERM.

**Every `/api` call returns 502 `upstream unavailable`** (log: `upstream error` with a `code` such
as `ECONNREFUSED` or `ENOTFOUND`): the backend address is wrong or the backend is down. **503
`EPOOLTIMEOUT`** (log: `upstream pool saturated`): the upstream socket pool is full — raise
`MAX_UPSTREAM_STREAM_SOCKETS` / `MAX_UPSTREAM_SOCKETS`, or add pods. **404 on an `/api` route the
backend has**: the BFF only forwards what `server/routes.ts` whitelists, and a backend behind a
path prefix needs the prefix in the ingress, not in `CHEMCLAW_API_URL`.

**Sign-in.**

- A configuration screen naming missing values: `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID` or `API_SCOPE`
  is not reaching `/config.js` — check `GET /config.js`.
- "AUTH_MODE=dev is not permitted in this production build": the image was built without
  `ALLOW_DEV_AUTH=true`. Use `AUTH_MODE=msal`, or rebuild for a dev deployment (§2).
- Signed in, but every API call is **401**: almost always one of three — `API_SCOPE` is not the
  API's scope (an ID token's `aud` is the SPA), the API registration issues v1 tokens (issuer
  `sts.windows.net` fails the backend's v2 issuer check), or `CHEMCLAW_ENTRA_AUDIENCE` does not
  match the token's `aud`. Decode the bearer and compare `aud`/`iss` with the backend's settings.
  README, "Enabling Entra SSO".
- **403** on a decision or a cancel: the user lacks a role in `CHEMCLAW_ENTRA_PRIVILEGED_ROLES`;
  `REVIEWER_ROLES` here should name the same roles so the control is not offered.
- Redirect errors at Entra (`AADSTS50011`): `https://<app host>/auth/callback` is not a redirect URI
  of the SPA registration.
- "People keep getting logged out", mostly Safari/Firefox: silent refresh runs through a hidden
  iframe that third-party-cookie blocking breaks. A known, accepted limit — `ISSUES.md` Issue 8.

**HTML artefacts show as source.** The notice says which case:

- "HTML preview needs a separate sandbox origin" — `SANDBOX_ORIGIN` is unset or `ALLOW_FRAMING=true`;
  the startup line `html sandbox off: …` says which.
- A notice naming both origins — the browser is at an address other than `APP_ORIGIN` (another
  hostname, `localhost` for `127.0.0.1`). Use exactly `APP_ORIGIN`.
- "The sandbox did not answer" (after 5 s) — the sandbox host is unreachable, or something in front
  of it rewrote its CSP, added `X-Frame-Options`, or put a login page (oauth-proxy, SSO) in the
  frame. The sandbox Route must reach `/sandbox/frame` with nothing authenticating or rewriting.

**No structures are drawn, behind a proxy or CDN.** The RDKit worker script
(`/assets/rdkit.worker-<hash>.js`) carries its own CSP with `'unsafe-eval'`; a proxy that sets one
CSP for every response breaks it. Pass the BFF's headers through per path (README, `ISSUES.md`
Issue 10).

**Answers arrive all at once, or streams drop.**

- All at once: something between browser and BFF buffers or compresses `text/event-stream`. The BFF
  sends `x-accel-buffering: no` and forces identity encoding upstream; an ingress must not gzip
  SSE. `npm run smoke` is the check — it fails on a buffered stream.
- A stream cut after a fixed idle time: an intermediary's idle timeout is shorter than
  `SSE_HEARTBEAT_MS` (15 s) — the OpenShift router's default is 30 s, so the default heartbeat
  clears it. Lower the heartbeat rather than raising every timeout.
- A turn that runs past ~600 s ends: that is the backend's wall clock, not the proxy.

**Shared conversations show a colleague's turn late.** It appears within `SHARED_POLL_MS` (5 s).

**Upload refused.** A 413 from this pod is `MAX_UPLOAD_BYTES` (32 MiB); the backend refuses an
attachment over its own `CHEMCLAW_ATTACHMENT_MAX_BYTES` (default 2 MB) and more than
`CHEMCLAW_ATTACHMENT_MAX_PER_SESSION` (default 10) per conversation.

**Where the browser's errors go.** `POST /api/client-events` → this pod's log, one JSON line per
entry. Every error banner quotes a `reference` — the correlation id — which joins the browser's
report, this pod's access line and the backend's log records.
