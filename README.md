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
  streams tool *invocations* only, so the panel says what was called, never what came back.
- **Renders structures** from SMILES — the `molecule_smiles` a finished QM job pushes back, plus an
  opt-in toggle on inline SMILES in answers.
- **Surfaces verifier signals** — a "needs expert review" pill at the *top* of a low-confidence
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

| Variable | Value |
| --- | --- |
| `ENTRA_TENANT_ID` | your tenant GUID |
| `ENTRA_CLIENT_ID` | **this SPA's** app registration (platform: Single-page application) |
| `API_SCOPE` | `api://<api-client-id>/<scope>`, e.g. `.../Chat.Access` |

Three things account for most "the token looks fine but the API returns 401" incidents:

1. **The scope must be the API's.** Requesting only `openid`/`profile` yields an *ID* token whose
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
  components/ui/    primitives (button, dialog, sheet, …) on Radix + cva
  components/chem/  composites built from them (StatusDot, ConfirmDialog, …)
shared/     the event contract, mirrored from the service's service/events.py
scripts/    dev launcher, server bundler, smoke test, contrast gate
e2e/        Playwright specs and the SSE fixture service
public/     theme boot script, favicon — served as-is by the BFF
```

Three files carry most of the difficulty and are commented accordingly:

- **`src/index.css`** — the design tokens, and one trap worth knowing before you add a
  theme-dependent one. **`@theme` cannot be nested to express a theme.** Tailwind v4 merges every
  `@theme` block into one map regardless of the at-rule around it, hoists the first into `:root` and
  deletes the rest, so last write wins unconditionally. This file used to carry a second `@theme`
  inside `@media (prefers-color-scheme: dark)`; it compiled to a single `:root` holding the *dark*
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
  `answer.text` is the *full concatenation* of every token. Any code path that combined them would
  render the whole answer twice. There is deliberately none.

## Testing

```sh
npm test              # vitest — store, stream parsing, route whitelist, component contracts
npm run typecheck
npm run check:contrast # WCAG ratios for every token pair the UI composes, both themes
npm run test:e2e      # Playwright — layout, focus, keyboard, theme, mobile drawer
```

`check:contrast` converts OKLCH to sRGB rather than comparing lightness values: OKLCH's `L` is
perceptual and WCAG is defined on sRGB relative luminance, so two tokens that look far apart can
still fail. That gap is exactly how white-on-accent survived in dark mode at roughly 2:1.

`test:e2e` runs the real BFF against `e2e/fixture-service.mjs`, which emits SSE frames with real
gaps between them. Stubbing the network inside the page would hand the whole body over at once and
pass against a chain that buffers end to end — the one failure this project most wants to catch.

Unit tests stub `fetch` with canned SSE bytes — no server is started. That is the only practical way
to exercise what a healthy backend will not produce on demand: frames split across chunk boundaries,
malformed frames, unknown event types, a stream that ends without an answer, and each of
401/404/409/422/429/503 mapping to the right typed error.

Everything else is verified against the real service.

## Backend requirements

`GET /sessions` and `GET /sessions/{id}/messages` (the conversation list and transcript read-back)
were added to Chemclaw3 alongside this UI, together with the fix that populates
`ApprovalRequestEvent.approval_id`. The UI degrades gracefully without them — the sidebar stays
local-only and transcripts come from `localStorage` — but history will not follow you between
devices.

Conversation history also needs the service running with `CHEMCLAW_SESSION_STORE=postgres`. Under
the in-memory store there is nothing durable to list or read back.
