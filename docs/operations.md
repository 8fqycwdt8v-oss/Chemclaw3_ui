# Operating the UI — build, configure, deploy, verify, troubleshoot

How to run `Chemclaw3_ui`. [`README.md`](../README.md) says what the UI does and covers the HTML
sandbox and Entra in more detail. Every default below is the one `server/config.ts` resolves (or the
file named beside it); where they disagree, the code is right.

---

## 1. What runs

One Node process, the **BFF** (`server/`, bundled to `dist/server.js`):

- serves the built SPA (`dist/client`) and `GET /config.js` — the browser's runtime configuration,
  rendered from this process's environment on every request, so **one image runs in any tenant**;
- proxies a **whitelist** of `/api/*` routes (`server/routes.ts`) to the Chemclaw3 FastAPI service
  at `CHEMCLAW_API_URL`, stripping the `/api` prefix — the browser never talks to the backend, so
  the backend needs **no CORS** (`CHEMCLAW_SERVICE_CORS_ORIGINS` stays empty) and is never exposed;
- answers its own `GET /healthz`, `GET /readyz` and `POST /api/client-events`;
- runs a **second listener** on `SANDBOX_PORT` (default 8081) that serves `GET /sandbox/frame` and
  nothing else, when the HTML sandbox is configured (README, "HTML sandbox (artefacts)");
- runs a **metrics listener** on `METRICS_PORT` (default 8082) that serves `GET /metrics` and
  nothing else, for an in-cluster scraper (§6). The app listener answers `/metrics` 404.

Under `AUTH_MODE=bff` the BFF also **signs users in and holds their tokens** (§8): it does the OIDC
authorization-code + PKCE exchange, keeps the access and refresh tokens in its own memory, gives
the browser one `HttpOnly; SameSite=Strict` session cookie, and injects the bearer on each proxied
request. The browser never sees a token and sends no `Authorization` header; any it does send is
dropped. `cookie`, `proxy-authorization`, `x-chemclaw-*` and the `x-forwarded-*` family are dropped
on the way upstream too. Under `dev` there is no sign-in and no credential.

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
| `REVIEWER_ROLES`    | empty                   | under `bff`       | Comma-separated app roles; must equal the backend's `CHEMCLAW_ENTRA_PRIVILEGED_ROLES`. Only hides controls that would 403 — the backend enforces. Ignored under `dev`.                    |
| `WARM_SESSIONS`     | `true`                  | no                | Create the backend session on the first keystroke so the first send is one round trip. Each conversation typed into costs the service one live-session slot. `false` turns it off.        |
| `SHARED_POLL_MS`    | `5000`                  | no                | How often an open shared conversation reads `GET /sessions/{id}/queue`. Whole ms, at least 250, else refused.                                                                             |

### Sign-in

None of the `ENTRA_*` values, the scope or the secret is sent to the browser (`GET /config.js` carries
`authMode` and nothing about the provider).

| Variable                        | Default                                      | Required    | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------- | -------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_MODE`                     | `dev`                                        | yes         | `bff` (the BFF signs users in and holds the tokens, §8) or `dev` (no credential). Anything else is refused; `msal` is refused by name.                                                                                                                                                                                                                                                                                                                                            |
| `APP_ORIGIN`                    | unset                                        | under `bff` | The origin the browser reaches the app at, exactly. It is the redirect URI's (`<APP_ORIGIN>/auth/callback`), the cookies' scheme, and the only `Origin` a state-changing request may carry. http only on loopback.                                                                                                                                                                                                                                                                |
| `ENTRA_TENANT_ID`               | empty                                        | under `bff` | Tenant GUID (not `common`/`organizations`/`consumers`). Not needed when `ENTRA_AUTHORITY` is set.                                                                                                                                                                                                                                                                                                                                                                                 |
| `ENTRA_CLIENT_ID`               | empty                                        | under `bff` | **This BFF's** app registration (platform: **Web**). Never set on the backend — it has no such setting and refuses unknown ones.                                                                                                                                                                                                                                                                                                                                                  |
| `ENTRA_CLIENT_SECRET`           | empty                                        | under `bff` | That registration's client secret. Prefer `ENTRA_CLIENT_SECRET_FILE`: a path to a mounted Secret, which wins over the variable. Never logged, never served.                                                                                                                                                                                                                                                                                                                       |
| `ENTRA_CLIENT_AUTH`             | `secret`                                     | no          | `none` makes the BFF a public client (PKCE alone, no secret): for a test tenant that issues no secret, or a single-page registration. It then sends `Origin: <APP_ORIGIN>` on token requests, because a single-page registration's codes are redeemed only for a request naming a registered origin (`AADSTS9002327`; Chemclaw3_mock enforces the same). A `secret` (Web) client sends none: Entra refuses a Web redemption that has one (`AADSTS9002326`). Entra needs `secret`. |
| `API_SCOPE`                     | empty                                        | under `bff` | `api://<api-client-id>/<scope>`, e.g. `…/Chat.Access`. Requested with `openid profile offline_access`.                                                                                                                                                                                                                                                                                                                                                                            |
| `ENTRA_AUTHORITY`               | `https://login.microsoftonline.com/<tenant>` | no          | A sovereign cloud or a test tenant. https (loopback excepted). Discovery is read from `<authority>/v2.0/.well-known/openid-configuration`.                                                                                                                                                                                                                                                                                                                                        |
| `ENTRA_ISSUER`                  | unset                                        | no          | Pins the issuer discovery must report. Unset: the ID token's `iss` is held to the issuer discovery reports.                                                                                                                                                                                                                                                                                                                                                                       |
| `ENTRA_END_SESSION`             | `true`                                       | no          | Offer the provider's end-session endpoint at sign-out. `false` ends only the BFF's session.                                                                                                                                                                                                                                                                                                                                                                                       |
| `SESSION_IDLE_MINUTES`          | `480`                                        | no          | A session unused this long ends.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `SESSION_MAX_AGE_HOURS`         | `24`                                         | no          | A session ends this long after sign-in, whatever it does; also the cookie's `Max-Age`.                                                                                                                                                                                                                                                                                                                                                                                            |
| `SESSION_MAX_SESSIONS`          | `10000`                                      | no          | Sessions held in memory (~5 kB each); the least recently used is dropped over it.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `TOKEN_REFRESH_SKEW_SECONDS`    | `120`                                        | no          | An access token with less than this left is renewed before it is used.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `LOGIN_STATE_TTL_SECONDS`       | `600`                                        | no          | A sign-in left unfinished is forgotten after this long.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `OIDC_HTTP_TIMEOUT_MS`          | `10000`                                      | no          | Every call to the identity provider (discovery, keys, token, revocation) gives up after this.                                                                                                                                                                                                                                                                                                                                                                                     |
| `TOKEN_REFRESH_BACKOFF_SECONDS` | `5`                                          | no          | After a failed refresh the provider is left alone this long; inside it an expired token is answered 503 at once.                                                                                                                                                                                                                                                                                                                                                                  |
| `SESSION_KEY`                   | random per process                           | no          | 32 or more random bytes as 64 hex characters or as base64 (`openssl rand -base64 32`), or `SESSION_KEY_FILE`; anything else is refused at boot. The key the sign-in cookie is sealed under. Unset, a pod restart mid-sign-in simply restarts that sign-in. Set it identically on every replica only if a callback may reach a pod other than the one that began it.                                                                                                               |
| `OIDC_MAX_INFLIGHT`             | `16`                                         | no          | Token-endpoint calls in flight at once, for sign-ins and for refreshes each. Past it a sign-in gets 503 with `Retry-After`. Not a rate limit: see "Required: a per-client limit at the router".                                                                                                                                                                                                                                                                                   |
| `ENTRA_ENDPOINTS_ORIGINS`       | empty                                        | no          | Comma-separated origins, besides the issuer's, that discovery may name endpoints on. Entra needs none (all its endpoints are on `login.microsoftonline.com`).                                                                                                                                                                                                                                                                                                                     |
| `ALLOW_INSECURE_AUTH`           | `false`                                      | no          | Permits `AUTH_MODE=dev` on a non-loopback `BIND_HOST`. Never in a shared deployment.                                                                                                                                                                                                                                                                                                                                                                                              |

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
| `METRICS_PORT`         | `8082`                                                      | The metrics listener's port, on `BIND_HOST`; 1–65535, not `PORT` or `SANDBOX_PORT`. Never put a Route on it.     |
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

| Variable         | Read by                                         | Meaning                                                                              |
| ---------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ALLOW_DEV_AUTH` | `vite.config.ts`, Dockerfile ARG                | `true` compiles the dev auth provider into the bundle. Default `false`.              |
| `CLIENT_OUT_DIR` | `vite.config.ts`, `scripts/compress-assets.mjs` | Where `vite build` writes; default `dist/client`.                                    |
| `BFF_PORT`       | `scripts/dev.mjs`, `vite.config.ts`             | The dev BFF's port (8787) that Vite proxies `/api` and `/config.js` to.              |
| `VITE_API_BASE`  | `src/env.ts`                                    | Fallback for a bare `vite dev` with no BFF; `/config.js` wins whenever it is served. |

---

## 4. Deploy to OpenShift

This repository ships **no chart**. [`deploy/openshift/`](../deploy/openshift/README.md) holds an
example Deployment, Service and two Routes, held to `server/config.ts` by
`tests/openshiftManifests.test.ts`. The release model is: an operator applies those once; every
later release is Jenkins re-pointing the Deployment by digest
(`oc set image deployment/chemclaw3-ui ui=<registry>/<image>@sha256:…`).

1. **Deploy Chemclaw3 first** (its Helm chart). The UI is useless before the API it proxies
   answers; the four-repository release order is Chemclaw3's `deploy/jenkins/README.md`.
2. **Register the BFF in Entra** (platform: **Web**, with a client secret; redirect URIs
   `https://<app host>/auth/callback` and `https://<app host>/`), and make sure the API's
   registration issues **v2** tokens (`accessTokenAcceptedVersion: 2`) and exposes the scope you put
   in `API_SCOPE`. Give the users the app roles named in `REVIEWER_ROLES`. §8 lists every setting.
3. **Create the client secret's Secret** — `oc create secret generic chemclaw3-ui-oidc
--from-literal=client-secret=<value>` — which the Deployment mounts read-only at
   `ENTRA_CLIENT_SECRET_FILE`. It is never committed.
4. **Copy and edit `deploy/openshift/`**: the two hosts (Routes) and the two origins
   (`APP_ORIGIN`/`SANDBOX_ORIGIN` = `https://` + those hosts, exactly), the tenant, client id and
   scope, `REVIEWER_ROLES`, and the image. `CHEMCLAW_API_URL` is `http://chemclaw-service:8080`
   when the chart is installed under its default name in the same namespace
   (`http://chemclaw-service.<ns>.svc:8080` from another). Keep the app Route's affinity cookie
   (§8): sessions are in each pod's memory. The pod must be able to reach the identity provider
   (§8, "Network").
5. `oc apply -n <ns> -f deploy/openshift/`.
6. **Point Jenkins at it**: `DEPLOY_TARGET=openshift`, `NAMESPACE`, `DEPLOYMENT=chemclaw3-ui`,
   `IMAGE_REGISTRY`, `CLUSTER_API`, the two credential ids, and `DRY_RUN=false`. The pipeline
   refuses to deploy without a registry digest.

**What the backend must be configured with for this UI** (Chemclaw3 settings, `CHEMCLAW_` prefix):

| Backend setting                                       | Value                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `CHEMCLAW_ENTRA_REQUIRED`                             | `true` with `AUTH_MODE=bff` (otherwise the UI's readiness fails — §6).          |
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
- **The backend can run more than one replica behind its Service.** The BFF reaches it through
  the Service, not the Route, so no affinity cookie applies — and none is needed: uploaded
  attachments are stored in Postgres (Chemclaw3 `session_attachments`, migration 120), and a
  running turn can be followed or stopped from any replica, which asks the pod holding it
  through Postgres (migration 121). Both need `CHEMCLAW_SESSION_STORE=postgres`, which this
  guide already requires. If the replica holding a turn does not answer in time, re-attach and
  Stop return 503 with `Retry-After`, which the SPA treats as retryable.

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

Signing in locally needs an identity provider the backend trusts. `AUTH_MODE=bff` with
`APP_ORIGIN=http://127.0.0.1:5173` (the plain-http loopback fallback: unprefixed, non-`Secure`
cookies) works with a real tenant's registration that lists that redirect URI, or with the fixture
provider for UI work only (`node --experimental-strip-types e2e/fixture-oidc.ts 4350 dev-client
http://127.0.0.1:5173/auth/callback http://127.0.0.1:5173/`, then `ENTRA_AUTHORITY=
http://127.0.0.1:4350/fixture-tenant ENTRA_CLIENT_ID=dev-client ENTRA_CLIENT_SECRET=fixture-secret`;
its tokens are not ones the backend accepts).

Chemclaw3's four-repository lanes start this UI themselves: `make live-e2e-full-stack` runs
`npm run dev` here against a front door on `127.0.0.1:8000`, and `make kind-up` deploys the UI
image to a kind cluster at `http://127.0.0.1:15173`.

`./start.sh` is for a hosted preview (Replit): it builds the client if missing, defaults
`CHEMCLAW_API_URL` to `http://127.0.0.1:8000` and `PORT` to 8099, and leaves the sandbox off.

---

## 6. Verify

| Check                     | Command / URL                                                    | Good answer                                                                                            |
| ------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| process up (liveness)     | `GET /healthz`                                                   | `200 {"status":"ok"}` — never consults the backend                                                     |
| can serve (readiness)     | `GET /readyz`                                                    | `200 {"status":"ready","upstream_status":200}`                                                         |
| runtime config            | `GET /config.js`                                                 | `window.__CHEMCLAW_CONFIG__={…}` with your `authMode`, `sandboxOrigin` — no tenant                     |
| signed-out answer         | `GET /auth/session`                                              | `200 {"authenticated":false}` (`bff` only)                                                             |
| sign-in starts            | `GET /auth/login`                                                | `302` to the authority's authorize endpoint, with `state`, `nonce`, S256 `code_challenge`              |
| sandbox listener          | `GET https://<sandbox host>/sandbox/frame`                       | 200 with its own CSP; `GET https://<app host>/sandbox/frame` is 404                                    |
| whitelist                 | `GET /api/metrics`                                               | 404 (never forwarded)                                                                                  |
| metrics stay in-cluster   | `GET https://<app host>/metrics`                                 | 404; `GET http://<pod>:8082/metrics` from inside the cluster is the exposition                         |
| the image's four promises | `npm run check:serving -- https://<app host>`                    | four ✓                                                                                                 |
| served contract = pin     | `npm run check:live-contract <service url>`                      | `ok`; drift names pinned vs served `info.version` (needs the service directly)                         |
| a real streamed turn      | `SESSION_COOKIE=<name>=<value> npm run smoke https://<app host>` | frames arrive **incrementally**; a signed-in browser's session cookie under `bff`, nothing under `dev` |

The startup log says what the process decided: one `listening` line (upstream, auth mode, version),
one `html sandbox on: …` or `html sandbox off: <reason>` line, and one `metrics on` line with the
metrics listener's address.

**Metrics.** `GET /metrics` on `METRICS_PORT` exposes `chemclaw_ui_requests_total`,
`chemclaw_ui_request_duration_seconds`, `chemclaw_ui_requests_in_flight` and
`chemclaw_ui_upstream_errors_total`, labelled by route pattern only; the sign-in counters (§7); and
`chemclaw_ui_sessions`, the signed-in sessions the pod holds (0 unless `AUTH_MODE=bff`, no labels).
It has no authentication, and says how busy the pod is and how many people are signed in, so it is
served on a port of its own that no Route targets: the app's port answers `/metrics` 404, so a
scrape aimed at the app host or the `http` port gets 404. Scrape the Service's `metrics` port from
inside the cluster. On OpenShift user-workload monitoring that is a `ServiceMonitor`:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: chemclaw3-ui
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: chemclaw3-ui
  endpoints:
    - port: metrics
      path: /metrics
```

Elsewhere, any scrape config that targets port 8082 of the pods (or `METRICS_PORT`) does the same.
A NetworkPolicy that admits only the monitoring namespace to that port narrows it further.

---

## 7. Troubleshoot

**The pod exits at once.** Read the `config: …` lines — each names the variable and why it was
refused. `EADDRINUSE` on `PORT`, `SANDBOX_PORT` or `METRICS_PORT` is one structured line naming the
address.

**`/readyz` is 503.** Its body says why:

- `"detail":"upstream unreachable"`, `upstream_status: 0` — `CHEMCLAW_API_URL` is wrong, the
  Service name or port is wrong, or a NetworkPolicy blocks UI → backend.
- `"detail":"upstream not ready"` — the backend's own `/readyz` is failing; look there.
- `"detail":"upstream accepts anonymous"` — the UI runs `AUTH_MODE=bff` and the backend answered
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

- The pod exits at once with `AUTH_MODE=msal no longer exists`: the mode that kept tokens in the
  browser is gone. Set `AUTH_MODE=bff` and the settings in §3 (a Web-platform registration with a
  client secret, `APP_ORIGIN`).
- "AUTH_MODE=dev is not permitted in this production build": the image was built without
  `ALLOW_DEV_AUTH=true`. Use `AUTH_MODE=bff`, or rebuild for a dev deployment (§2).
- `/auth/login` answers 503 "Sign-in is unavailable": the pod cannot reach the authority
  (discovery at `<authority>/v2.0/.well-known/openid-configuration`). A NetworkPolicy or egress proxy
  (§8, "Network"), the wrong `ENTRA_AUTHORITY`, or `ENTRA_ISSUER` not equal to the issuer discovery
  reports (the log says which).
- The callback shows "Sign-in was refused": the log line `sign-in failed` (keyed by the page's
  reference) carries the reason — `AADSTS` text is deliberately not shown to the person. Common:
  the client secret expired or is wrong (`invalid_client`), the redirect URI is not registered
  (`AADSTS50011` at Entra, before the callback), the ID token's audience is not `ENTRA_CLIENT_ID`.
- "You signed in, but this browser did not keep the session": the browser refused the cookie, **or**
  the next request reached another pod. With more than one replica the router must keep a browser on
  one pod (§8); on OpenShift the app Route must not set `disable_cookies: 'true'`.
- Signed in, but every API call is **401** `session_expired`: the provider refused to renew
  (refresh token expired, revoked, or a Conditional Access policy now wants a fresh sign-in). The
  page sends the person through sign-in again; the log has `refresh refused; ending the session`
  with the OAuth error.
- Signed in, but every API call is **401 from the backend**: almost always one of three — `API_SCOPE`
  is not the API's scope (an ID token's `aud` is this client), the API registration issues v1 tokens
  (issuer `sts.windows.net` fails the backend's v2 issuer check), or `CHEMCLAW_ENTRA_AUDIENCE` does
  not match the token's `aud`. The BFF renews once and replays, so a persistent 401 is the backend's
  verdict on a fresh token. README, "Enabling Entra SSO".
- **403** `csrf` on an API call: the request lacked `X-Chemclaw-Csrf` or came from another origin.
  The SPA sends it on every call; a hand-made `curl` must add `-H 'X-Chemclaw-Csrf: 1'` and the
  session cookie.
- **403** on a decision or a cancel: the user lacks a role in `CHEMCLAW_ENTRA_PRIVILEGED_ROLES`;
  `REVIEWER_ROLES` here should name the same roles so the control is not offered.
- Everyone signed out after a release: sessions are in each pod's memory (§8). The next page load
  signs them in again without a prompt while the provider's own session lasts.
- `chemclaw_ui_auth_events_total{event=…}` on `/metrics` counts `login_started`, `login_completed`,
  `login_failed`, `logout`, `refresh`, `refresh_failed`, `session_ended`, `session_missing` and
  `csrf_refused`: a rising `session_missing` is the affinity symptom, `refresh_failed` the
  provider's. `chemclaw_ui_login_failures_total{reason=…}` splits sign-in failures into `state`,
  `provider_error`, `exchange_rejected`, `id_token`, `idp_unavailable` and `busy`: a rise in `state`
  or `exchange_rejected` with no matching `login_completed` is somebody probing `/auth/callback`,
  and `busy` is the in-flight cap holding. The `sign-in failed` log line carries the same reason, no
  secret and no code. A sign-in answered 503 "Sign-in is unavailable" with `Retry-After` is the
  provider being down or `busy`.

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
CSP for every response breaks it. Pass the BFF's headers through per path (README, "Enabling Entra
SSO").

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

---

## 8. Token custody

Under `AUTH_MODE=bff` the BFF is a **token handler**: it completes the OIDC sign-in, holds every
token on the server, and the browser holds an opaque session id and nothing it can turn into API
access. This is the decision, what it does, and what a human verifies against a real tenant.

### What the browser holds

| Where                                                                                          | What                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cookie `__Host-chemclaw_session`                                                               | 256 random bits. `HttpOnly; Secure; SameSite=Strict; Path=/`, **no `Domain`**. `Max-Age` = `SESSION_MAX_AGE_HOURS`.                                                                                                                                                                                                                                                              |
| Cookie `__Host-chemclaw_login_<tag>`                                                           | During a sign-in only (`LOGIN_STATE_TTL_SECONDS`): the whole sign-in, sealed (AES-256-GCM), named for a hash of its `state`. `HttpOnly; Secure; SameSite=Lax` (the provider's redirect back is cross-site). One per tab signing in: six at most, expired ones cleared first, then the oldest — never one younger than 30 s (a seventh sign-in is then refused with 429 instead). |
| `localStorage`, `sessionStorage`, `document.cookie`, `/config.js`, any response body or header | **No token, ever.** `tests/bffFlow.test.ts` and `e2e/bff-auth.spec.ts` assert it.                                                                                                                                                                                                                                                                                                |

`__Host-` and `Secure` apply exactly when `APP_ORIGIN` is https. A plain-http `APP_ORIGIN` is
accepted for loopback only (local development), with unprefixed, non-`Secure` cookies, because
browsers differ on `Secure` over http; the startup log warns.

### The flow

1. `GET /auth/login?returnTo=/path` mints `state`, `nonce` and a PKCE verifier and keeps **nothing
   on the server**: they travel in a sealed cookie (AES-256-GCM; the key is derived from
   `SESSION_KEY`, or random per process), whose name carries a tag of the `state` and whose
   authentication covers that tag, so a value cannot be moved to another name. It redirects to the
   authority with `code_challenge_method=S256`, `scope=openid profile offline_access <API_SCOPE>`
   and the one `redirect_uri` (`<APP_ORIGIN>/auth/callback`, never taken from the request).
   `returnTo` survives only as a rooted path on this origin: printable ASCII, at most 512
   characters, no `//host`, scheme or backslash, nothing under `/auth/` or `/api/`.
2. `GET /auth/callback` opens the cookie named for its `state` (one begun in another browser, damaged,
   expired or sealed under another key finds nothing), marks the `state` spent in a bounded,
   expiring set per pod (best effort: it narrows a replay of the sealed cookie while the entry
   lasts; the provider's single-use code is the real guard), exchanges the code with the
   client secret and the verifier, and validates the ID token with `jose`: an asymmetric signature
   against the provider's published keys (cached; re-read when an unknown `kid` arrives, so rotation
   needs no restart), `iss` equal to the issuer discovery reports (and to `ENTRA_ISSUER` when
   pinned), `aud` equal to `ENTRA_CLIENT_ID`, `exp` present and in the future (60 s of clock skew),
   and `nonce` equal to this sign-in's. Then it creates the session under a **new** random id and
   deletes any session the browser held (no fixation), sets the cookie and redirects to `returnTo`
   with `signed_in=1`, which the SPA removes. Any failure is a short page with a way back in; the
   reason is in the log, never in the page.
3. Every `/api/*` request: refuse if it is cross-site (below); find the session by its cookie; take
   the bearer (renewing first if less than `TOKEN_REFRESH_SKEW_SECONDS` is left); drop the browser's
   own `Authorization`, `Cookie` and `X-Chemclaw-*`; send the request with `Authorization: Bearer`.
   The turn stream and job stream go through the same path, so SSE keeps its pool and heartbeat.
4. **Renewal is one refresh per session at a time**: every request that finds the token about to
   expire waits for the same call, so a burst costs the provider one request. A refusal
   (`invalid_grant`, `interaction_required`, …) ends the session (401 `session_expired`, cookie
   cleared; the page signs in again). A provider that cannot be reached leaves the session alone: a
   token with life left carries the request (the provider is left alone for 5 s), one without gets
   503 `idp_unavailable` with `Retry-After`. A provider that rotates refresh tokens is followed.
5. **A backend 401 renews once and replays.** The refused request is held, the token is renewed
   (requests refused with the same token share one renewal; a renewal that did not help is not
   repeated for 30 s), and the request is sent again with the same body. Every route but the
   attachment upload is replayable (the body is held in memory, up to `MAX_BODY_BYTES`); an upload's
   401 is relayed and the page re-checks its session (`handleUnauthorized`).
6. `POST /auth/logout` (needs the CSRF header): deletes the session, revokes the refresh token where
   the provider has a revocation endpoint (Entra has none; best effort), clears the cookie, and
   answers `{endSessionUrl}` — the provider's end-session endpoint with `client_id` and
   `post_logout_redirect_uri=<APP_ORIGIN>/`, no token in it — which the SPA then navigates to.
   `GET /auth/logout` is 405, so a link or image cannot sign anyone out.

### Cross-site requests

`SameSite=Strict` is the first wall. The BFF also refuses, for every `/api` route, `/auth/session`
and `/auth/logout`: a request the browser marks `Sec-Fetch-Site: cross-site` or `same-site`; for any
method but GET/HEAD/OPTIONS, an `Origin` other than `APP_ORIGIN`; and every `/api` request,
**GET included**, without `X-Chemclaw-Csrf: 1` (a header no other origin can set without a CORS
preflight, which this process never answers; some reads consume what they return, and a plain
`<img src>` in the sandbox host's HTML — the same site — cannot send it). The response is 403
`csrf`. `GET /auth/session` alone is exempt from the header: it consumes nothing.

### The decision: where sessions live

The platform's shared state is Postgres; the BFF has no database, and the UI reaches the service
over HTTP only. Four options:

| Option                                                     | For                                                                                                                                                               | Against                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **(a) Memory in each BFF pod, router affinity** _(chosen)_ | One refresh per session is trivially single-flight. Logout and a refused refresh revoke at once. No token leaves the server; no second secret; no new dependency. | A pod restart or release forgets its sessions (the next page load signs the person in again silently while the provider's session lasts; nothing else is lost — conversations are in the browser and the service). More than one replica needs the router to keep a browser on one pod.                                                                                                                                        |
| (b) Sealed, encrypted cookie holding the session           | Stateless: any replica serves any request, no affinity, survives restarts.                                                                                        | The refresh token lives in the browser (encrypted): a copied cookie is a session no logout can revoke. A renewal must rewrite the cookie, but concurrent requests carry the old one — a refresh stampede, and a provider with refresh-token reuse detection revokes the family. An Entra access token plus refresh token overflows 4 kB, so the cookie is split across several. A second managed secret with a rotation owner. |
| (c) A core API for sessions                                | One place for session state, shared with the service.                                                                                                             | The BFF must call core before it has a user token, so it needs a service credential; new core routes and a table; core would hold every user's provider refresh token. Cross-repo.                                                                                                                                                                                                                                             |
| (d) The BFF writes Postgres itself                         | The platform's answer for shared state; survives restarts and removes affinity.                                                                                   | A driver in the bundle, a connection, credentials and a schema owned by a repository with no migrations; the UI's "HTTP to core only" boundary goes.                                                                                                                                                                                                                                                                           |

(a) is chosen because the costs it moves are operational and visible (a router annotation; a
silent re-sign-in after a release), while (b)'s are security properties and (c)/(d) are another
team's schema. **Revisit when** releases are frequent enough that the silent re-sign-in is noticed,
or when a deployment needs more replicas than affinity serves: then (d), with sessions in a table
the service owns and the BFF reads over (c)'s API. The session store is one class
(`server/auth/sessions.ts`); nothing else knows it is memory.

**Multi-replica.** Sessions are per pod. On OpenShift the app Route's default cookie affinity keeps
a browser on one pod (`deploy/openshift/routes.yaml` states it; the sandbox Route disables cookies
on purpose). Elsewhere: ingress-nginx `nginx.ingress.kubernetes.io/affinity: cookie`, or an
equivalent. Without affinity a sign-in appears to work and the next request reaches a pod that never
saw the session: the page stops with "this browser did not keep the session" and
`chemclaw_ui_auth_events_total{event="session_missing"}` rises. A pod that dies takes its sessions
with it; the router sends those browsers elsewhere and they sign in again.

**Limits.** A session ends after `SESSION_IDLE_MINUTES` unused or `SESSION_MAX_AGE_HOURS` in all
(both below the provider's refresh-token life, so these — not the provider — decide how often a
chemist signs in). At most `SESSION_MAX_SESSIONS` are held; the least recently used is dropped.
`chemclaw_ui_sessions` on `/metrics` is how many a pod holds now, so its distance from the cap (and
the drop at a release) can be watched.
A sign-in in progress costs the server nothing (it is the browser's cookie), so there is no cap to
exhaust and no shared counter for an anonymous flood to spend: one host hammering `/auth/login`
cannot stop anyone else signing in. Restarting a pod mid-sign-in invalidates its cookies (random
key) and the person sees "Try again". With several replicas the router affinity this section
already requires keeps the callback on the pod that began it; a shared `SESSION_KEY` is only for a
deployment whose callback can land elsewhere (the _spent states_ set is still per pod, so a replay
across pods is bounded by the provider's single-use code and the cookie's life alone).

**Required: a per-client limit at the router.** `/auth/login` and `/auth/callback` are open to
anyone, and each callback can cost one call to the identity provider carrying the client secret
(the BFF only checks the `state` it sealed, not the code). `OIDC_MAX_INFLIGHT` bounds how many
run at once and `chemclaw_ui_login_failures_total` makes a flood visible, but neither is a rate
limit, and the BFF cannot tell clients apart: behind the router every request arrives from the
router, and the forwarded address is something a client can write. So a per-source-IP limit at the
router, ingress or WAF is a **required deployment control**, not an option. On OpenShift the
example app Route carries it (`haproxy.router.openshift.io/rate-limit-connections` with
`concurrent-tcp`, `rate-tcp` and `rate-http`, counted per source address per 3 seconds;
`deploy/openshift/routes.yaml`, held by `tests/openshiftManifests.test.ts`); elsewhere an
equivalent (ingress-nginx `limit-rps`/`limit-connections`). Raise the numbers for an office whose
users share one address.

**Live requests end with their session.** Sign-out, expiry, eviction and a refused refresh end
every request still running under the session — an open job stream included — and the request to
the service is destroyed with it; a request not yet answered gets 401 `session_expired` (and the session cookie is cleared). An open
stream counts as use of the session — it is touched while the stream runs — so a person whose only
traffic is a job stream is not idled out under it. Sessions are capped in number
(`SESSION_MAX_SESSIONS`) but not per account (`ISSUES.md` Issue 27).

### Network

The BFF now makes **outbound HTTPS calls**: discovery, the key set, the token endpoint (and
revocation where offered) at the authority — `login.microsoftonline.com` by default. A NetworkPolicy
or egress firewall must allow the pod to reach it. Node's `fetch` does not read `HTTPS_PROXY`
unless `NODE_USE_ENV_PROXY=1` is set (Node 22.21 or later); behind an egress proxy set it with
`HTTPS_PROXY` and `NO_PROXY`. A test authority with a private CA: `NODE_EXTRA_CA_CERTS=<file>`.

### Entra configuration

| Setting              | Value                                                                                                                                                                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BFF app registration | Platform **Web** (not Single-page application: a server-side redemption against an SPA registration is refused: `AADSTS9002327`). Supported account types: this tenant only.                                                                                                                             |
| Redirect URIs        | `https://<app host>/auth/callback` **and** `https://<app host>/` (Entra requires the post-logout URI to be a registered redirect URI). Exactly `APP_ORIGIN` plus the path; one host per deployment.                                                                                                      |
| Client secret        | Created on that registration; its value is the Secret `chemclaw3-ui-oidc`. Expires (24 months at most): rotate by adding a second secret in Entra, updating the Secret, restarting, then deleting the first. A certificate or federated credential is not supported here.                                |
| API permissions      | Delegated permission to the API's scope (`Chat.Access`) with admin consent, so the sign-in does not prompt for it. `offline_access` and `openid`/`profile` are requested by the BFF.                                                                                                                     |
| API registration     | `accessTokenAcceptedVersion: 2`; exposes the scope in `API_SCOPE`; its app roles are what the backend's `CHEMCLAW_ENTRA_PRIVILEGED_ROLES` reads from the **access** token.                                                                                                                               |
| Authority / issuer   | `https://login.microsoftonline.com/<tenant GUID>`; discovery reports `…/<tenant GUID>/v2.0`. Use the GUID, not a domain name, or pin `ENTRA_ISSUER`. Sovereign clouds: `ENTRA_AUTHORITY`.                                                                                                                |
| Scopes               | `openid profile offline_access api://<api-client-id>/Chat.Access`.                                                                                                                                                                                                                                       |
| Cookie domain        | None: host-only, so the cookie belongs to exactly `APP_ORIGIN`'s host. A second hostname for the same app is a second sign-in and needs its own redirect URI and `APP_ORIGIN`.                                                                                                                           |
| Token lifetimes      | Access tokens 60–90 minutes (renewed with `TOKEN_REFRESH_SKEW_SECONDS` left). Refresh tokens 90 days sliding, shortened by Conditional Access sign-in frequency; the BFF's session limits are shorter.                                                                                                   |
| Claims read          | From the ID token: `oid` (else `sub`), `name`, `preferred_username`, `roles`. From discovery: the issuer. Group claims are not read or needed. The `roles` here come from the **BFF registration's** app roles, which only hide controls (`REVIEWER_ROLES`); the backend enforces from the access token. |

### What a human verifies against a real tenant

Real Entra cannot be run from CI. The fixture provider (`e2e/fixture-oidc.ts`) and Chemclaw3_mock
cover the protocol; these remain, and nothing below has been done:

1. **A first sign-in completes** on the real registration: the callback redirects, `/auth/session`
   answers `authenticated`, and `GET /api/sessions` is 200 (so core accepted the injected bearer:
   `aud`, v2 `iss`, `scp`). Decode the bearer from a **server** log or debugger — never from the
   browser, where it must not be.
2. **`SameSite=Strict` survives the redirect back from Entra.** Both automated lanes run on one site
   (`127.0.0.1`), so a browser's cross-site rule is not exercised. In Chrome, Firefox and Safari:
   sign in from a fresh profile and confirm the page loads signed in with no second redirect. The
   design does not depend on the cookie accompanying the redirect itself (the shell is static and
   `/auth/session` is a same-site fetch), but a browser could still refuse to _store_ it.
3. **Cookie attributes in DevTools** (Application, Cookies): `__Host-chemclaw_session`, `HttpOnly`,
   `Secure`, `SameSite=Strict`, `Path=/`, no `Domain`, and nothing in local or session storage.
4. **Renewal**: leave a tab open past the access token's life (60–90 min). No sign-out; `refresh`
   rises in `chemclaw_ui_auth_events_total`. Safari and Firefox with tracking protection on: the
   old "keeps logging me out" (silent refresh through a third-party iframe) must be gone.
5. **Conditional Access / MFA**: a policy that demands fresh authentication makes the next refresh
   fail with `interaction_required`; the person is sent through sign-in and lands back on the page.
6. **Sign-out**: Entra's end-session endpoint returns to `https://<app host>/` (needs the second
   redirect URI) and the next visit asks for credentials or the account picker. Check Entra
   honours `client_id` on `/oauth2/v2.0/logout`; if it shows an account picker every time, that is
   Entra's behaviour without `id_token_hint`/`logout_hint`, which the BFF does not send to avoid
   putting an ID token in a URL.
7. **Egress**: the pod reaches the authority (discovery, `discovery/v2.0/keys`, token) through the
   NetworkPolicy or proxy; `/auth/login` is not 503.
8. **Affinity**: with two replicas, sign in and make 50 calls with no `session_missing`; delete the
   pod holding the session and confirm the person is signed in again and lands where they were.
9. **Secret rotation** as above, with no one signed out of a running pod (sessions already hold
   their tokens; only new sign-ins and refreshes use the secret).
10. **Roles**: compare `REVIEWER_ROLES` with the `roles` claim the BFF registration puts in the ID
    token for a reviewer and a non-reviewer; they must show the controls the backend will accept.
11. **Clock**: pod time within 60 s of Entra's (ID-token `exp`/`nbf` tolerance).
