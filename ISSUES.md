# Open Issues — Chemclaw3_ui

File these at: https://github.com/8fqycwdt8v-oss/Chemclaw3_ui/issues/new

---

## Issue 1: happy-dom@^16.0.0 blocked by Replit security policy — prevents full devDependency install

**Repo:** Chemclaw3_ui

When running `npm install` on Replit, `happy-dom@16.8.1` (resolved from `^16.0.0`) is blocked by
the platform's package security policy:

```
npm error 403 Forbidden - GET http://package-firewall.replit.local/npm/happy-dom/-/happy-dom-16.8.1.tgz - Blocked by Security Policy
```

This prevents installing any devDependencies (including `vite`, `@vitejs/plugin-react`, etc.) because
npm resolves the full dependency tree before installing.

**Workaround applied on Replit:** Removed `happy-dom` and `vitest` from `package.json`
devDependencies so `vite build` can run. Tests currently cannot be run on Replit.

**Fix options:**

1. Pin `happy-dom` to an older version not flagged by the CVE scanner (e.g. `^15.x`)
2. Replace `happy-dom` with `jsdom` as the vitest environment
3. Use `npm overrides` to pin to a non-flagged patch release

**Impact:** `npm test` (vitest) cannot run on Replit without this fix. Build and server are fine.

**Update — the pin now carries a critical advisory.** `npm audit` reports `happy-dom@15.11.7` as
**critical**: GHSA-37j7-fg3j-429f, a VM context escape leading to RCE, affecting everything
`<= 20.8.8`. It is dev-only — the vitest DOM environment, never shipped to the browser and absent
from the runtime image, which carries no `node_modules` at all — but it does execute in CI.

So option 1 above ("pin to an older version not flagged by the scanner") is no longer available:
there is no `15.x` that clears it. The live choice is between upgrading past `20.8.8` and moving
the environment to `jsdom`, and the tradeoff is not ours alone to make — the constraint that forced
the pin is Replit's package firewall, which is external to this repo. Whoever still runs this on
Replit should confirm the upgrade is not re-blocked before we commit to it.

`nanoid@3.3.16` (dev, transitive via `postcss`) is also flagged **high** — infinite loop on zero
size — and is fixable non-breaking with no such tradeoff.

---

## Issue 2: GET /api/sessions and GET /api/sessions/{id}/messages whitelisted in BFF but missing from backend

The BFF route whitelist (`server/routes.ts`) includes:

- `GET /api/sessions` → `/sessions` (list sessions)
- `GET /api/sessions/{sid}/messages` → `/sessions/{sid}/messages` (read transcript)

Both return `404`/`405` from the Chemclaw3 FastAPI backend (only `POST /sessions` and
`POST /sessions/{id}/messages` exist).

**Impact:** Sidebar conversation list is local-only; transcripts fall back to `localStorage`.

**Fix:** Add to `service/app.py` in Chemclaw3:

- `GET /sessions` — list sessions for current principal (needs `CHEMCLAW_SESSION_STORE=postgres`)
- `GET /sessions/{session_id}/messages` — return stored transcript

---

## Issue 3: GET /approvals and POST /approvals/{id}/decision missing from backend

The BFF whitelists:

- `GET /api/approvals` → `/approvals`
- `GET /api/approvals/{id}` → `/approvals/{id}`
- `POST /api/approvals/{id}/decision` → `/approvals/{id}/decision`

All return `404`. The `InteractionApprovalWorkflow` exists in the backend but has no HTTP surface.

**Impact:** Approve/Reject buttons in the UI 404 when clicked; approval holds cannot be completed
via the browser.

**Fix:** Implement the REST surface in `service/app.py`:

- `GET /approvals` — list pending holds
- `GET /approvals/{hold_id}` — describe one hold
- `POST /approvals/{hold_id}/decision` — signal the Temporal workflow

---

## Issue 4: a shared conversation link cannot survive the backend rotating its session

`/s/:sessionId` adopts a server session into a local conversation, which makes a link portable
between devices. That is the most this data model can back, and it is less than it sounds.

The session id is a **disposable handle**, not a conversation identity. The client replaces it in
three places — `session_not_found` recovery, `resetSession`, and a fresh conversation — and the
backend is free to evict it from its live-session store. So a shared link:

- **dies** once the backend rotates or evicts that session, with no way to tell the recipient what
  it used to point at; and
- **changes under the sharer mid-conversation**, because the id they copied is not the id their
  conversation will be using after the next recovery.

The local conversation id, which is stable, is meaningless to any other device — it names a row in
one browser's `localStorage`.

**Fix:** a stable server-side conversation id, distinct from the session handle, with the session
as a child of it. `GET /conversations/{cid}/messages` would then be resolvable by anyone
authorised, whatever session is current. Until that exists, `/s/:sessionId` is a best-effort
convenience and the UI says so when the link no longer resolves.

---

## Issue 5: the backend's live-session budget is unknown, and the client now spends it faster

`warmSession` creates the backend session on the first keystroke so the first message costs one
round-trip instead of two. It also changes what a session _means_ in aggregate: the population went
from "conversations someone sent a message in" to "conversations someone typed a character into",
which is strictly larger and includes abandoned drafts.

This repo does not know the service's live-session LRU size, its per-principal cap, or what it does
when either is exceeded — the 429 path in `useJobStreams` exists because the same question applies
to concurrent event streams and had no answer either.

**Mitigation already in place:** `warmSessions` is a `/config.js` flag (`server/runtimeConfig.ts`,
`src/env.ts`), default on, switchable without a client rebuild.

**Question for the service:** what is the live-session cap per principal, what is the eviction
policy, and is a session created and never used cheaper than one that streamed a turn?

---

## Known gaps in the UI rebuild (`claude/frontend-optimization-design-2agt1q`)

The rebuild's commit messages describe what was built. This records what was not.

Closed since the first version of this section, and listed only because it was written down as
missing: long-transcript windowing with `content-visibility` and a Load earlier control; the boot
sequence painting before auth resolves; `warmSession`; a durable, cross-conversation job feed with
a title badge and opt-in notifications; path routing with a working Back button; conversation
search; upload progress and cancellation; `@axe-core/playwright` in the e2e suite.

**Still not done:**

- **A pending-approvals inbox.** `api.listApprovals` now degrades to `[]` on a 404 like its
  siblings, but there is no UI. Issue 3 above is why: the endpoint does not exist on the backend,
  so an inbox would be built against nothing.
- **Screenshot baselines.** The axe pass covers the mechanical half of the visual contract; nothing
  guards against a layout regression that is still accessible.
- **Durable sharing** — Issue 4.
- **A real MSAL redirect has not been exercised against this router.** The `/auth/callback` route
  is structured so nothing writes the URL until `handleRedirectPromise()` has consumed the
  fragment, and the e2e suite runs in `dev` auth mode, which cannot prove it.

  This gap has now cost something concrete. See Issue 6.

---

## Issue 6: the framing headers blocked MSAL's own silent token renewal, and the fix is unverified

`acquireTokenSilent` renews through a hidden iframe. That iframe goes to Entra, and Entra redirects
it **back to our own** `redirectUri` — `${window.location.origin}/auth/callback` — which the BFF
serves as the SPA fallback. So the app ends up framing itself.

In every non-`dev` mode the BFF was sending `frame-ancestors 'none'` (`server/config.ts`) and
`X-Frame-Options: DENY` (`server/index.ts`). Both forbid framing **including same-origin**, so the
callback document could never render inside the renewal iframe: MSAL never read the fragment and
the token silently stopped being renewable roughly an hour after login. That is the same class of
failure the comment above `buildCsp` warns about for `connect-src` — "looks like a random logout and
is miserable to trace back to a header" — reached through a different directive.

`frame-src` was never the problem: it governs where we may frame _to_, and already allowed Entra.

**Fixed here** — `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`. Cross-origin framing,
which is what clickjacking actually requires, is still refused. `tests/csp.test.ts` pins both
directions.

**Still unverified, and this is the point:** nothing in this repo can prove the fix works, for the
same reason nothing caught the bug. The e2e suite runs in `dev` auth mode and takes neither branch.
**One login against a live tenant, left idle past the access token's lifetime (~1 hour), is what
settles it.** Until someone does that and records the result here, treat Entra silent renewal as
untested rather than working.
