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
- **Answers approvals.** A durable hold gets real Approve/Reject buttons wired to
  `POST /approvals/{id}/decision`; a plan approval says plainly that it is answered by your next
  message, because that is the only channel the service has for it.
- **Survives a reload** — conversations persist locally and rehydrate from the service.
- **Is ready for Entra SSO** without a rewrite: one env var switches the auth provider.

## Quick start

### Both servers with Docker Compose

Expects the Chemclaw3 checkout as a sibling directory (override with `CHEMCLAW_REPO`):

```sh
export ANTHROPIC_API_KEY=...        # or CHEMCLAW_LLM_PROVIDER=openai_compatible + OPENAI_API_KEY
docker compose up --build
open http://localhost:3000
```

This brings up Postgres/pgvector, Temporal, the Chemclaw3 service, and this UI. Only the UI
publishes a port; the backend stays on the internal network.

### Against a locally-run backend

```sh
# in the Chemclaw3 repo
uv sync
CHEMCLAW_ENTRA_REQUIRED=false CHEMCLAW_SERVICE_HOST=127.0.0.1 \
  uv run uvicorn chemclaw.api.app:create_app --factory --port 8080

# here
npm install
npm run dev            # UI on :5173, proxying through the BFF on :8787
```

`CHEMCLAW_API_URL` points the UI server at the service (default `http://127.0.0.1:8080`).

`npm run dev` binds the BFF to loopback, which is what makes `AUTH_MODE=dev` acceptable there.
**Anywhere else, dev auth on a non-loopback bind is refused at startup** — see Configuration.

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

The backend enforces Entra when `CHEMCLAW_ENTRA_REQUIRED=true`. Set an authenticated `AUTH_MODE`
here at the same time. There are two, and they differ in **who holds the token**:

| `AUTH_MODE` | Who completes the OIDC flow | Where the token lives  | XSS can steal a token? |
| ----------- | --------------------------- | ---------------------- | ---------------------- |
| `bff`       | this server                 | sealed httpOnly cookie | no                     |
| `msal-spa`  | MSAL, in the browser        | `sessionStorage`       | yes                    |

`bff` is the default and the recommendation. Under `msal-spa` a bearer token sits in web storage
for the life of the tab, readable by any script that runs on the origin — a compromised dependency,
an extension, a hole in a renderer — and usable from anywhere for its full lifetime. Under `bff`
the page never sees a token at all: requests authenticate by cookie and this server attaches the
bearer on the way through.

> **`AUTH_MODE=msal` now resolves to `bff`.** An existing deployment that changes nothing will
> **refuse to start** until `ENTRA_CLIENT_SECRET` and `SESSION_SECRET` are set, and the refusal says
> so. To keep the previous browser-MSAL behaviour exactly as it was, set `AUTH_MODE=msal-spa`.

Both modes need:

| Variable          | Value                                                   |
| ----------------- | ------------------------------------------------------- |
| `ENTRA_TENANT_ID` | your tenant GUID                                        |
| `ENTRA_CLIENT_ID` | **this app's** own registration                         |
| `API_SCOPE`       | `api://<api-client-id>/<scope>`, e.g. `.../Chat.Access` |

`bff` additionally needs:

| Variable              | Value                                                                    |
| --------------------- | ------------------------------------------------------------------------ |
| `ENTRA_CLIENT_SECRET` | a client secret — this is a **confidential** client                      |
| `SESSION_SECRET`      | ≥32 chars, seals the session cookie (`openssl rand -base64 48`)          |
| `PUBLIC_ORIGIN`       | this deployment's browser-facing origin, e.g. `https://chem.example.com` |

**The app registration's platform differs by mode**, and this is the easiest thing to get wrong:
`bff` needs a **Web** platform with `<PUBLIC_ORIGIN>/auth/callback` as a redirect URI, while
`msal-spa` needs a **Single-page application** platform. Presenting a client secret against a SPA
registration is refused with AADSTS9002326, which does not read as "wrong platform".

#### What BFF custody costs

Worth stating plainly rather than discovering:

- **CSRF becomes a real surface.** Before this the origin carried no cookies, so a cross-site
  request carried no credentials. It does now, and three independent checks defend it:
  `SameSite=Lax`, an `Origin`/`Referer` comparison, and a double-submit token the SPA echoes in
  `x-csrf-token`. See `server/auth/csrf.ts`.
- **The session lives in a cookie, and cookies have a size limit.** An Entra access token runs
  1–2 KB and a refresh token about 1 KB, so a sealed session is split across up to four numbered
  cookies. Exceeding that ceiling **throws** rather than truncating — a truncated session would
  present as "sign-in randomly does not stick", which is close to undiagnosable from a bug report.
- **There is no server-side session store, so there is no revocation.** A sealed cookie is valid
  until it expires; `/auth/logout` clears the browser's copy rather than invalidating a record.
  That is the trade for a stateless design that survives a restart and scales across replicas with
  nothing new to run.
- **A real tenant round trip is untested in this repo.** The flow is covered by unit tests, by an
  end-to-end suite against a mock provider (`tests/bffAuthFlow.test.ts`), and by a browser suite
  against a second mock (`e2e/bffAuth.spec.ts`) — but there is no tenant here, so the first genuine
  confirmation will be a real sign-in.

Three things account for most "the token looks fine but the API returns 401" incidents:

1. **The scope must be the API's.** Requesting only `openid`/`profile` yields an _ID_ token whose
   `aud` is the SPA client id; the backend checks `aud == CHEMCLAW_ENTRA_AUDIENCE`. Graph's
   `.default` is equally wrong.
2. **The API app registration needs `accessTokenAcceptedVersion: 2`.** The backend pins the issuer
   to `https://login.microsoftonline.com/{tenant}/v2.0`; a v1 token is issued by `sts.windows.net`
   and fails the issuer check.
3. **There is no `CHEMCLAW_ENTRA_CLIENT_ID` on the backend.** Its settings model is
   `extra="forbid"`, so exporting one aborts its startup. The SPA client id belongs only here.

Under `msal-spa`, silent token refresh uses a hidden iframe to `login.microsoftonline.com`, so the
CSP is relaxed for that mode (`server/config.ts`). Copying the backend's `connect-src 'self'`
verbatim breaks refresh about an hour after login — a failure that looks like a random logout.
`bff` needs none of those relaxations, because nothing in the browser talks to Entra: sign-in is a
plain top-level navigation, which CSP does not govern. So `bff` ships the strict policy.

## Layout

```
server/     the BFF — route whitelist, streaming proxy, static host, /config.js, auth/
src/        the SPA — api/ auth/ state/ components/
shared/     the event contract, mirrored from the service's service/events.py
scripts/    dev launcher, server bundler, smoke test
docs/       backend-requests.md — the changes this frontend needs upstream, with anchors
```

Two files carry most of the difficulty and are commented accordingly:

- **`server/proxy.ts`** — every SSE trap. Chiefly: it forces `accept-encoding: identity` (a
  compressed event stream buffers until the compressor's window fills), and it destroys the upstream
  request when the client disconnects. That last line is what makes **Stop** work: the service has
  no cancel endpoint, so propagating the disconnect is the only way it releases the session's turn
  lock — without it, the next message comes back 409.
- **`src/state/chatStore.ts`** — the store keeps `streamedText` and `finalText` apart because
  `answer.text` is the _full concatenation_ of every token. Any code path that combined them would
  render the whole answer twice. There is deliberately none.

## Testing

```sh
npm run typecheck
npm run lint
npm test              # vitest — unit and component
npm run test:e2e      # playwright, against the built bundle and the real BFF
npm run smoke:boot    # the server bundle boots from a bare dist/, as the container runs it
npm run check:contract
```

Unit tests stub `fetch` with canned SSE bytes — no server is started. That is the only practical way
to exercise what a healthy backend will not produce on demand: frames split across chunk boundaries,
malformed frames, unknown event types, a stream that ends without an answer, and each of
401/404/409/422/429/503 mapping to the right typed error.

End-to-end tests (`e2e/`) drive a real browser against the **built** artefact served by the real
BFF, because the things worth catching there are production-path properties a dev server does not
have: that `/config.js` loads at all, that the SPA fallback resolves, and that SSE frames arrive
incrementally rather than in one clump. They run against a mock backend that speaks the generated
contract, since a genuine turn needs a model credential.

### The contract check

`shared/backend-contract.json` is generated from a real Chemclaw3 checkout by
`scripts/gen_backend_contract.py` — the backend serves no OpenAPI, deliberately, so the source of
truth is its code. `npm run check:contract` then asserts, in both directions, that the BFF route
whitelist, the SSE event union, every event's field set, the error taxonomy and the client's
endpoint list still match it.

Regenerate it when the backend moves:

```sh
CHEMCLAW_REPO=/path/to/chemclaw3 npm run gen:contract
```

The resulting diff _is_ the drift report: decide what this frontend should do about each change,
rather than discovering months later that an event has been silently dropped.

## Backend requirements

Verified against Chemclaw3 `8a47952`; `shared/backend-contract.json` records the exact surface and
CI fails if this repo drifts from it.

Conversation history, the Runs panel and the Proposals queue all need the service running with
`CHEMCLAW_SESSION_STORE=postgres`. Under the in-memory store `GET /sessions` returns `[]` by design
and there is nothing durable to list or read back. The durable-job and proposal surfaces
additionally need Temporal and pgvector — `make live-infra` in the backend repo stands both up,
including on hosts with no Docker daemon.

## Security posture

Two settings decide whether this UI is safe to expose, and both fail closed:

- **`AUTH_MODE=dev` on a non-loopback bind is refused at startup.** Every request would run as a
  shared principal with all authorization gates open, so the server exits rather than warning.
  `ALLOW_INSECURE_AUTH=true` is the explicit, greppable opt-out; `docker-compose.yml` and
  `start.sh` set it because both are local/preview deployments.
- **A production bundle does not contain the dev auth provider** unless built with
  `ALLOW_DEV_AUTH=true`, and `scripts/assert-no-dev-auth.mjs` checks the built output rather than
  trusting the bundler to have eliminated it. Without this, a `/config.js` that failed to load
  silently selected a provider that sends no `Authorization` header at all.

An `AUTH_MODE` value that is none of `bff`, `msal-spa` or `dev` is a startup error, not a fallback.

A third setting is worth listing alongside the two above, because it is what makes the strongest
posture the default: **`AUTH_MODE=bff` keeps the bearer token out of the browser entirely**, so the
worst an XSS on this origin can do is make requests while the user is present, rather than walk away
with a token it can replay from anywhere for the next hour.
