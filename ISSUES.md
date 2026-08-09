# Open Issues — Chemclaw3_ui

File these at: https://github.com/8fqycwdt8v-oss/Chemclaw3_ui/issues/new

**Verified against `8fqycwdt8v-oss/Chemclaw3` @ `c46b004`** (`src/chemclaw/api/routes/*.py`,
`src/chemclaw/api/schemas.py`, `src/chemclaw/api/deps.py`, `src/chemclaw/core/config/service.py`).
Everything below either survived that reading or was written as a result of it. Three issues did
not survive, and are recorded as closed rather than deleted — a gap that was real and got fixed is
worth being able to find again.

---

## Closed: happy-dom blocked by the Replit security policy (was Issue 1)

`happy-dom` is pinned at `^15.11.7` in `package.json` and `vitest` is back in devDependencies. The
403 was on `16.8.1`; option 1 of the three recorded fixes was taken. `npm test` runs.

## Closed: `GET /sessions` and `GET /sessions/{id}/messages` missing from the backend (was Issue 2)

Both exist (`routes/sessions.py`), owner-scoped through the durable ownership registry, and both
are already in the BFF whitelist. `GET /sessions` returns `SessionSummary[]`; it is empty under
`session_store="memory"`, because there is no durable registry to enumerate and reporting the
process's live LRU instead would answer a deployment question with an eviction-dependent guess.

`GET /sessions/{id}/messages` came back **richer** than the shape this UI was written against: each
`TranscriptMessage` now carries `index` and `tool_calls[]`, so a reload can restore what the agent
_did_ and not only what it said. The client was still mapping the old shape and hardcoding
`trace: []`; that is fixed (`src/state/transcript.ts`).

## Closed: `/approvals` missing from the backend (was Issue 3)

`GET /approvals`, `GET /approvals/{id}` and `POST /approvals/{id}/decision` all exist
(`routes/approvals.py`), every one of them gated by `owned_approval`. The pending-approvals inbox
that this issue was blocking is built (`src/components/ApprovalsInbox.tsx`).

---

## Issue 4: `GET /sessions` cannot populate a conversation list on its own

**Repo:** Chemclaw3 (backend)

`SessionSummary` is `{session_id, created_at}`. A sidebar needs a name and a recency, and neither is
derivable from that:

- **No title.** A session is minted before anyone has spoken, so the server has no name for it at
  creation — and nothing revisits the row afterwards. Every restored conversation therefore reads
  the same.
- **No last-activity.** `created_at` is when the session was _started_. Sorting a conversation list
  by it puts a session opened last Tuesday and abandoned above one used an hour ago.

**Mitigated client-side, at a cost.** The UI now renames a restored conversation from the first
user message in its transcript — but only once that conversation is opened, because the title comes
out of `GET /sessions/{id}/messages`. So the sidebar still shows "Earlier conversation" for every
session the chemist has not clicked into yet, and fixing that from here would mean fetching every
transcript on boot to read one line out of each.

**Fix:** add `title` and `updated_at` to `SessionSummary`. The title can be derived server-side from
the session's first user message at write time (the same rule this UI applies locally), and
`updated_at` is the newest `session_messages` row. Both are one column each on a table the listing
already reads.

---

## Issue 5: a shared conversation link is a second-device link, not a shared one

`/s/:sessionId` adopts a server session into a local conversation. Two readings of that were wrong
in the earlier version of this note, and both matter.

**Durability is better than assumed.** Under `session_store="postgres"` the session id is a durable
row in the ownership registry, and `deps._rehydrate_session` rebuilds a live handle over its
persisted history after an eviction or a pod restart — on the session's own profile, not the default
one. `service_max_live_sessions` (1000) bounds an in-process _cache_, not the session's existence.
So a link does not die when the pod forgets the session. Under `session_store="memory"` there is no
registry and the link is good only for the life of one process.

**Shareability is worse than assumed.** Every session-scoped route resolves through
`_refuse_unless_owner`, which 404s anyone who is not the session's owner — indistinguishably from an
unknown id, deliberately. A link handed to a colleague does not degrade; it looks to them like the
conversation does not exist. `/s/:sessionId` is therefore a _second-device_ link for one person, and
the UI should not imply otherwise.

The rotation hazard is real but narrower than written: the client replaces the id in three places
(`session_not_found` recovery, `resetSession`, a fresh conversation), and a link copied before one
of those points at a session the sharer is no longer using.

**Fix, if cross-person sharing is ever wanted:** a stable server-side conversation id distinct from
the session handle, with an explicit grant — not just a durable id, because the 404 above is an
authorization decision and would still apply.

---

## Issue 6: the per-user event-stream cap is shared across tabs, and no client can see it

`service_max_event_streams_per_user` defaults to **5**, enforced per principal per process
(`routes/streams.py`), alongside a per-pod `service_max_event_streams_total`. `useJobStreams` budgets
3, which fits — for one tab. Two tabs on the same account ask for six and the second tab's last
stream 429s.

Nothing client-side can see the other tab's usage: the count lives in the pod's memory. The 429 path
handles it (two in a row drops that tab to a single stream for the life of the page, bringing the
pair back under the cap), so the failure is contained rather than silent — but it is handled, not
prevented, and a chemist with two windows quietly watches fewer conversations than they think.

**Fix (client):** elect one tab to hold the streams for all of them over a `BroadcastChannel`, and
have the others read completions from the shared store. That is a feature with its own failure modes
(leader crash, heartbeat timeouts), which is why it is filed rather than half-built.

---

## Issue 7: the live-session budget under `warmSession`

`warmSession` creates the backend session on the first keystroke so the first message costs one
round-trip instead of two. It also changes what a session means in aggregate: from "conversations
someone sent a message in" to "conversations someone typed a character into".

**Most of the original question is now answered.** `service_max_live_sessions` is 1000 and bounds an
LRU _cache_ of in-process handles, evicting the least-recently-used; the durable history survives
eviction, and a session with no turns has no history rows to survive. A warmed-and-abandoned session
therefore costs one ownership row plus, briefly, one cache slot — cheaper than a used one, and
evicted before it. `service_max_listed_sessions` (100) bounds what `GET /sessions` returns.

**What is still open** is not capacity but hygiene: nothing ever deletes the ownership rows of
sessions that were warmed and never used, so a chemist's `GET /sessions` fills with empty
conversations. The UI cannot tell them apart from the outside — an unused session and a session
whose transcript failed to load both come back as an empty array.

**Mitigation in place:** `warmSessions` is a `/config.js` flag (`server/runtimeConfig.ts`,
`src/env.ts`), default on, switchable without a client rebuild.

**Fix:** either have `GET /sessions` omit sessions with no messages, or expose a message count on
`SessionSummary` so the client can. The former is better — it is the same query.

---

## Known gaps in the UI rebuild (`claude/frontend-optimization-design-2agt1q`)

The commit messages describe what was built. This records what was not.

Closed since the first version of this section: long-transcript windowing with `content-visibility`
and a Load earlier control; the boot sequence painting before auth resolves; `warmSession`; a
durable, cross-conversation job feed with a title badge and opt-in notifications; path routing with
a working Back button; conversation search; upload progress and cancellation;
`@axe-core/playwright` in the e2e suite; the pending-approvals inbox; tool calls surviving a reload.

**Still not done:**

- **Screenshot baselines.** The axe pass covers the mechanical half of the visual contract; nothing
  guards a layout regression that is still accessible.
- **A real MSAL redirect has not been exercised against this router.** `/auth/callback` is
  structured so nothing writes the URL until `handleRedirectPromise()` has consumed the fragment,
  and the URL-sync effects live inside the `/c/:id` element rather than behind a pathname check, so
  they structurally cannot run on the callback path. The e2e suite runs in `dev` auth mode and
  cannot prove any of it.
- **`npm run smoke` against a real service.** The e2e fixture emits real time-gapped SSE frames
  through the real BFF, which is not the same as a real backend.
- **Profile selection.** `GET /profiles` exists and `POST /sessions` accepts a `profile`, which
  narrows the agent's tool surface for the session's whole life. Nothing in this UI offers the
  choice, so every conversation runs on the default profile.
