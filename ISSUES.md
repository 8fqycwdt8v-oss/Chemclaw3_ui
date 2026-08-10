# Open Issues — Chemclaw3_ui

File these at: https://github.com/8fqycwdt8v-oss/Chemclaw3_ui/issues/new

**Verified against `8fqycwdt8v-oss/Chemclaw3` @ `c46b004`** — the whole route table, plus
`api/schemas.py`, `api/deps.py` and `core/config/service.py`. Several entries here were written
from the outside and turned out to be wrong about the service in both directions: things assumed
missing that exist, and things assumed safe that are not. Closed items are kept rather than
deleted, because a gap that was real and got fixed is worth being able to find again.

---

## Closed: happy-dom blocked by the Replit security policy (was Issue 1)

`happy-dom` is pinned at `^15.11.7` and `vitest` is back in devDependencies. The 403 was on
`16.8.1`; the first of the three recorded options was taken. `npm test` runs.

## Closed: `GET /sessions` and `GET /sessions/{id}/messages` missing (was Issue 2)

Both exist in `routes/sessions.py`, owner-scoped through the durable ownership registry, and both
are in the BFF whitelist. `GET /sessions` is empty under `session_store="memory"` — there is no
durable registry to enumerate, and reporting the process's live LRU would answer a deployment
question with an eviction-dependent guess.

## Closed: `/approvals` missing (was Issue 3)

`GET /approvals`, `GET /approvals/{id}` and `POST /approvals/{id}/decision` all exist in
`routes/approvals.py`, every one gated by `owned_approval`. `ReviewQueue` is the surface.

## Closed: three ways to serve an unauthenticated UI by accident

Not filed before being fixed, and recorded because the shape is worth recognising again: all three
were paths to "no sign-in required" that nobody chose, and each looked like a working deployment.

- `AUTH_MODE` resolved every unrecognised value to `dev`. `AUTH_MODE=MSAL`, `entra`, or a value
  carrying a trailing newline out of a secret manager booted with no sign-in, `frame-ancestors *`
  and no `X-Frame-Options`. Now refused at startup, naming the value it was given.
- `validateConfig` claimed in its own docstring to mirror the backend's
  `_refuse_unauthenticated_exposure` while only logging a warning. Dev auth on a non-loopback bind
  is now refused unless `ALLOW_INSECURE_AUTH=true` declares it deliberate. The loopback test also
  gained `::1`, which the old inline check reported as an exposure it was not.
- `createDevAuth` was a static import and an unconditional fallback, so the no-token provider sat
  in the entry chunk of every build — `dev@localhost` was grep-able in a release bundle — one
  failed `/config.js` fetch from being the active provider. Now behind `import.meta.env.PROD` and
  the `__ALLOW_DEV_AUTH__` define, with `scripts/assert-no-dev-auth.mjs` asserting it against the
  emitted chunks in **both** directions, so a stale marker string fails loudly rather than passing
  for nothing.

---

## Issue 4: `GET /sessions` cannot populate a conversation list on its own

**Repo:** Chemclaw3 (backend)

`SessionSummary` is `{session_id, created_at}`. A sidebar needs a name and a recency, and neither
is derivable from that:

- **No title.** A session is minted before anyone has spoken, so the server has no name for it at
  creation, and nothing revisits the row afterwards.
- **No last-activity.** `created_at` is when the session was _started_. Sorting by it puts a
  session opened last Tuesday and abandoned above one used an hour ago.

**Mitigated client-side, at a cost.** A restored conversation is renamed from the first user
message in its transcript — but only once it is opened, because that is when
`GET /sessions/{id}/messages` runs. So the sidebar still reads "Earlier conversation" for every
session the chemist has not clicked into, and fixing that from here would mean fetching every
transcript on boot to read one line out of each.

**Fix:** add `title` and `updated_at` to `SessionSummary`. The title can be derived server-side
from the session's first user message at write time — the same rule this UI applies locally — and
`updated_at` is the newest `session_messages` row. Both come off tables the listing already reads.

---

## Issue 5: a shared conversation link is a second-device link, not a shared one

`/s/:sessionId` adopts a server session into a local conversation. Two things this note used to say
were wrong, in opposite directions.

**Durability is better than assumed.** Under `session_store="postgres"` the session id is a durable
row in the ownership registry, and `deps._rehydrate_session` rebuilds a live handle over its
persisted history after an eviction or a pod restart — on the session's own profile, not the
default one. `service_max_live_sessions` (1000) bounds an in-process _cache_, not the session's
existence. A link does not die when the pod forgets the session. Under `session_store="memory"`
there is no registry and the link lasts one process.

**Shareability is worse than assumed.** Every session-scoped route resolves through
`_refuse_unless_owner`, which 404s a non-owner indistinguishably from an unknown id, deliberately.
A link handed to a colleague does not degrade — to them the conversation simply does not exist. So
`/s/:sessionId` is a second-device link for one person, and the UI must not imply otherwise.

The rotation hazard is real but narrower than written: the client replaces the id in three places
(`session_not_found` recovery, `resetSession`, a fresh conversation), so a link copied before one
of those points at a session the sharer has stopped using.

**Fix, if cross-person sharing is ever wanted:** a stable server-side conversation id distinct from
the session handle, _with an explicit grant_ — a durable id alone is not enough, because the 404
above is an authorization decision and would still apply.

---

## Issue 6: the per-user event-stream cap is shared across tabs, and no client can see it

`service_max_event_streams_per_user` defaults to **5**, enforced per principal per process
(`routes/streams.py`) beside a per-pod `service_max_event_streams_total`. `useJobStreams` budgets
3, which fits — for one tab. Two windows on one account ask for six, and the second window's last
stream 429s.

Nothing client-side can see the other tab's usage: the count lives in the pod's memory. The 429
path contains it (two in a row drops that tab to a single stream for the life of the page, which
brings the pair back under the cap), so the failure is handled rather than silent — but handled is
not prevented, and a chemist with two windows watches fewer conversations than they think.

**Fix (client):** elect one tab to hold the streams over a `BroadcastChannel` and have the others
read completions from the shared store. That is a feature with its own failure modes — leader
crash, heartbeat timeouts — and a botched election loses notifications entirely, which is strictly
worse than the contained degradation above. Filed rather than half-built.

---

## Issue 7: warmed sessions are never cleaned up

`warmSession` creates the backend session on the first keystroke so the first message costs one
round-trip instead of two. It also changes what a session means in aggregate: from "conversations
someone sent a message in" to "conversations someone typed a character into".

**The capacity question is answered.** `service_max_live_sessions` is 1000 and bounds an LRU
_cache_ of in-process handles; durable history survives eviction, and a session with no turns has
no history to survive. A warmed-and-abandoned session costs one ownership row plus, briefly, one
cache slot — cheaper than a used one, and evicted before it. `service_max_listed_sessions` (100)
bounds the listing.

**What is open is hygiene, not capacity.** Nothing deletes the ownership rows of sessions that were
warmed and never used, so `GET /sessions` fills with empty conversations. The client cannot filter
them: an unused session and a session whose transcript failed to load both come back as `[]`.

**Mitigation in place:** `warmSessions` is a `/config.js` flag (`server/runtimeConfig.ts`,
`src/env.ts`), default on, switchable without a client rebuild.

**Fix:** have `GET /sessions` omit sessions with no messages, or expose a message count on
`SessionSummary` so the client can. The former is better — it is the same query.

---

## Issue 8: the access token lives in the browser, and its refresh runs on a mechanism browsers are removing

**Decided, not merely open.** Moving token custody to the BFF was designed, built and tested on
`claude/frontend-hardening-stabilization-gqxzko` (PR #11, closed), and deliberately not adopted.
This entry exists so the next person reads the reasoning instead of re-deriving it — and so the
symptom below is recognised when it appears, because it will not look like a decision anyone made.

**Where things stand.** `src/auth/msalAuth.ts` holds an Entra access token in the browser, and
`src/api/client.ts` and `src/api/streamTurn.ts` send it as an `Authorization` header. This origin
sets no cookies at all, and `server/proxy.ts:92` strips the `cookie` header on the way upstream to
keep the service's `allow_credentials=false` posture true — so neither side has a CSRF surface
today.

**Two costs, and the second one has a clock on it.**

- Any script running on this origin can read the token — ours, a dependency's, or a supply-chain
  compromise of one. This app ships RDKit-WASM, Ketcher and a large npm tree, so that surface is
  not hypothetical. An `httpOnly` cookie can be _used_ by injected script but not _read_, which
  confines an attacker to this origin instead of handing them a portable credential.
- MSAL refreshes silently through a hidden iframe to `login.microsoftonline.com`, which depends on
  third-party cookies. Safari's ITP and Firefox's ETP already block them and Chrome is removing
  them. When the iframe fails, MSAL falls back to an interactive redirect **mid-session**.
  `server/config.ts` already carries `frame-src`, `connect-src` and `form-action` exceptions for
  `login.microsoftonline.com` to keep this working at all.

**The symptom to recognise.** "People keep getting logged out", reported first and most often by
Safari and Firefox users. That is upstream browser policy arriving, not a regression here — and
without this note it reads like a bug in the router or the session handling, which is where the
time would go.

**Why it was not adopted.** The BFF design is sound — stateless AES-256-GCM sealed cookie, HKDF-
derived key, `__Host-` prefix, chunked because Entra tokens exceed the 4 KB cookie limit, three
independent CSRF checks, ~1,500 lines of tests. The objections are operational rather than
technical:

- It makes the BFF a **confidential client**, so the Entra app registration needs a Web platform, a
  client secret and `<origin>/auth/callback` as a redirect URI. That is a tenant admin action, not
  a config edit, and in a regulated tenant it is a ticket and a wait.
- Two new managed secrets. `ENTRA_CLIENT_SECRET` expires — an unrenewed one means nobody can log
  in. Rotating `SESSION_SECRET` logs everyone out, because stateless means there is no record to
  migrate.
- It trades a known risk for a different one: no cookies today means nothing to forge, and cookies
  create a CSRF surface. Mitigated three ways over, but it is a trade rather than a strict win.
- **No revocation.** A sealed cookie is valid until it expires; logout clears the cookie rather
  than invalidating a record. If "revoke this user immediately" is ever a GxP requirement, the
  stateless design cannot satisfy it without the server-side store it exists to avoid.

**What would change the answer:** a confirmed confidential-client registration in the target
tenant, or the refresh failures above becoming common enough to be the bigger operational cost.
Reopen PR #11 rather than rebuilding — the branch is retained.

---

## Known gaps in the UI rebuild

The commit messages describe what was built. This records what was not.

Closed since the first version of this section: long-transcript windowing with
`content-visibility` and a Load earlier control; the boot sequence painting before auth resolves;
`warmSession`; a durable, cross-conversation job feed with a title badge and opt-in notifications;
path routing with a working Back button; conversation search; upload progress and cancellation;
`@axe-core/playwright` in the e2e suite; the review queue for holds and proposals; the durable-run
registry; profile selection; tool calls surviving a reload.

**Still not done:**

- **Screenshot baselines.** The axe pass covers the mechanical half of the visual contract; nothing
  guards a layout regression that is still accessible.
- **A real MSAL redirect has not been exercised against this router.** `/auth/callback` is
  structured so nothing writes the URL until `handleRedirectPromise()` has consumed the fragment,
  and the URL-sync effects live inside the `/c/:id` element rather than behind a pathname check, so
  they structurally cannot run on the callback path. The e2e suite runs in `dev` auth mode and
  cannot prove any of it.
- **`npm run smoke` against a real service.** The e2e fixture emits real time-gapped SSE frames
  through the real BFF, which is not the same thing as a real backend.
- **`PendingApproval` is still typed loosely** (`[key: string]: unknown`, every field optional).
  The service's shape is three required strings — `approval_id`, `question`, `requested_by`
  (`agent/interaction_tools.py`) — so the index signature is known information left on the floor.
  Tightening it touches `ReviewQueue`, so it is a change of its own.
