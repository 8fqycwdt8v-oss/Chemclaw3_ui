# Code Review — Chemclaw3 UI

Reviewed at `aa1e4b9`. Baseline: every CI gate green (typecheck, lint, format, 125 unit tests,
46/46 contrast pairs, build, Playwright desktop + mobile).

## Method, and what it actually produced

A 22-agent fleet reviewed the repository in three tiers — 9 area agents (deep, file-owning), 5 seam
agents (following one value across layers), 8 dimension agents (a11y, performance, CSS tokens,
types, tests, docs-truth, supply chain, and an adversarial agent treating model output as hostile).
Every agent carried a 22-entry register of the codebase's documented deliberate decisions and was
bound to read a file's header comment before filing against it.

**The automated verification stage never ran.** 21 of 22 agents returned; the 22nd never did, so the
barrier before verification never resolved. The 21 agents produced **89 findings**, none of which
had been adversarially checked.

Everything in the "Confirmed" section below was therefore **verified by hand** — by reading the
cited code, and where a claim was behavioural, by executing it. Two findings were proven with
runnable reproductions; one was corrected downward from its original claim. The remaining 70
findings are listed unverified at the end and should be treated as leads, not results.

**Confirmed: 5 critical, 5 high.** All ten are real, and all ten sit in code no test exercises.

---

## Critical

### C1 · Every citation chip in every answer renders empty

`src/components/Markdown.tsx:50`

`src/lib/citations.ts:73` emits `#cite/${kind}/${token}`. The consumer strips the `#cite/` prefix
and splits, yielding exactly **two** elements — but destructures with a leading hole:

```ts
const [, kind = 'note', id = ''] = href.slice('#cite/'.length).split('/');
```

Proven: for `#cite/note/NOTE-123` the array is `["note","NOTE-123"]`, so `kind` receives
`"NOTE-123"` and `id` falls off the end and defaults to `""`.

Consequences, all of them user-visible: `CitationChip` renders `{id}` — an **empty, zero-width
button with no accessible name**; the note id is deleted from the answer text the chemist is
reading; `PALETTE[kind]` misses so reaction and QM citations never get their colour; the `title`
reads "Ask the agent to expand "; and clicking prefills the composer with
`"Expand  — what are the conditions, outcomes, and caveats?"`, sending the agent a question with no
subject.

**Fix:** `const [kind = 'note', id = ''] = …` — delete the leading hole.
**Test:** none exists — `citations.ts`, `Markdown.tsx` and `CitationChip.tsx` have zero test
contact. A unit test asserting `#cite/note/NOTE-1` renders a chip labelled `NOTE-1`.

### C2 · An upstream failure after headers hangs the browser forever

`server/proxy.ts:143`

`upstreamRes.pipe(res)` does not forward source errors, and the error handler at line 179 is on
`upstreamReq`, not `upstreamRes`.

Proven with a runnable harness (fake upstream sends headers, then destroys the socket): the error
surfaces on **`upstreamRes`** as `aborted` + `ECONNRESET`. The `upstreamReq` handler never fires, so
`res` is never ended or destroyed. The client response stays open indefinitely — no error, no FIN,
and no log line. Confirmed for both the JSON and the SSE path.

Corrected from the original finding: this does **not** crash the process. `pipe()` attaches its own
source error listener, so there is no unhandled `error` event. The failure is a hang, not a crash.

For a turn stream the user sees the answer stop mid-sentence with no error state; for a JSON route
the `fetch` never settles.

**Fix:** handle `upstreamRes.on('error' | 'aborted')` — log, then `res.destroy()` (headers are
already sent, so a status cannot be written). Note this must not disturb the `res.on('close')`
disconnect propagation at line 175, which is load-bearing for Stop.
**Test:** `server/` has no unit tests at all beyond `routes.test.ts`.

### C3 · Entra silent token refresh is structurally impossible in production

`server/config.ts:52` + `server/index.ts:44`

MSAL renews tokens through a hidden iframe. That iframe navigates to Entra, which redirects it
**back to this app's own origin** — `redirectUri: ${window.location.origin}/auth/callback`
(`src/auth/msalAuth.ts:31`). `server/index.ts:31` confirms the SPA fallback serves `/auth/callback`
as `index.html` through `sirv`, whose `setHeaders` stamps:

- `x-frame-options: DENY` for every non-dev mode (`index.ts:44`) — i.e. exactly MSAL mode
- `frame-ancestors 'none'` for every non-dev mode (`config.ts:52`)

Both forbid the app being framed _at all_, including by itself. The renewal iframe cannot render
the callback document, MSAL never reads the fragment, and `acquireTokenSilent` times out.

`frame-src: [ENTRA_HOST]` is correct and not the problem — that governs the outbound navigation.
The blocking directives are the ones governing who may frame this app.

This is the failure `buildCsp`'s own comment describes — "a failure that looks like a random logout
and is miserable to trace back to a header" — reached through frame directives rather than
`connect-src`. It is invisible today because, per `ISSUES.md`, _"a real MSAL redirect has not been
exercised against this router… the e2e suite runs in dev auth mode, which cannot prove it."_

**Fix:** in msal mode allow same-origin framing of the callback — `frame-ancestors 'self'` and
either omit `x-frame-options` or use `SAMEORIGIN`. Narrowing the exemption to `/auth/callback` keeps
`DENY` everywhere else.
**Test:** not reachable in dev auth mode; verify against a live tenant and record the result in
`ISSUES.md`, which already tracks this as unproven.

### C4 · The GxP plan gate silently downgrades to an unbound approval

`src/components/Prompts.tsx:157`

`AuthContext.tsx:13-15` states the contract: _"`ready` is what consumers gate on. Anything that
needs a token — sending, uploading, the session list, the transcript read, the job streams — must
wait for it."_

The plan read needs a token and does not gate on `ready`. Its effect depends only on
`[sessionId, token]` and fires on mount. The shell deliberately renders before auth resolves
(`AuthContext.tsx:4-6`), against `pendingAuth`, whose `getAccessToken` **throws** by design. The
bare `catch` at line 166 collapses that into `setState('unavailable')`, which renders the fallback
for "a service that predates the plan route": an unbound, non-hash-bound approval answered in the
conversation.

`token` is a `useCallback` with `[]` deps, so the effect never re-runs when auth becomes ready. The
downgrade is permanent for the life of the card.

The same bare `catch` also downgrades on any transient 503/500/401, not just the documented 404 —
this was filed separately as `Prompts.tsx:166` and has the same root cause and the same fix.

This converts an irreversible, attributable, plan-hash-bound sign-off into an unattributable one.
Given the domain, that is the most consequential defect in this review.

**Fix:** gate the effect on `ready`; discriminate the `catch` so only a genuine 404 reaches
`'unavailable'`, and a transient failure produces a retryable error state.
**Test:** mount the card with auth pending, assert it does not enter `'unavailable'`.

### C5 · Two tabs silently destroy each other's conversations

`src/state/chatStore.ts:666`

Each tab hydrates `chemclaw3.chat.v2` once at module load, then writes its **entire** in-memory
snapshot over that key on every `set()`. Verified by absence: there is no `storage` listener, no
`BroadcastChannel`, and no `navigator.locks` anywhere in `src/`.

A tab open since before another tab created a conversation will overwrite it on its next store
mutation. Multiple tabs are an expected usage pattern here — `msalAuth.ts` deliberately uses
`sessionStorage` so tokens are per-tab, accepting "a silent re-auth per new tab".

**Fix:** subscribe to `storage` and merge, or take a `navigator.locks` write lock. Merging is the
honest option since conversations are keyed by id.
**Test:** two store instances over one shared storage mock; assert neither loses the other's
conversation.

---

## High

### H1 · The Retry button after a failed turn is a guaranteed no-op

`src/App.tsx:139` (corroborated independently by three agents)

`TopBar.tsx:8-11` documents the intent exactly: the retryable kinds (503 `capacity`, and the BFF's
own 502 mapped to `network`) "produced a red bar with no way forward", so a Retry action was added.

But the only handler wired to it clears the banner and bumps `rehydrateNonce`, which re-runs the
**remote transcript read** — guarded by `if (… || messageCount > 0 || !fromServer) return`
(`App.tsx:63`). After a failed turn the conversation always has messages, and a locally-created
conversation is not `fromServer`. Both guards exclude it.

The button looks actionable, clears the error, and does not resend the turn. The chemist's message
is already gone from the composer.

**Fix:** give the banner's retry a producer-specific handler — resend the failed turn for turn
failures, rehydrate for transcript failures.

### H2 · Every store write re-serialises the whole transcript to localStorage

`src/state/chatStore.ts:679`

zustand `persist` runs `partialize` + `JSON.stringify` + a **synchronous** `localStorage.setItem`
on every `set()`. `partialize` maps every message of up to `MAX_CONVERSATIONS` conversations.

Measured on a 30-message / ~65 KB transcript with the real middleware: each write serialises the
full transcript, so at the streaming rAF rate this is roughly **4 MB/s of main-thread
`JSON.stringify` plus blocking storage I/O** for the duration of every answer.

Worse and simpler: `setDraft` (line 589) calls `set()` on **every keystroke**, and `drafts` is not
in the persisted slice. Measured: 40 keystrokes produced 40 full-transcript writes of byte-identical
data. That work is pure waste.

**Fix:** exclude non-persisted-slice mutations from triggering a write (or debounce the write);
at minimum keep `setDraft` off the persist path.

### H3 · A localStorage quota error escapes every store action

`src/state/chatStore.ts:675`

Verified by absence: there is **no `try`/`catch` anywhere in `chatStore.ts`** and no
`QuotaExceededError` handling in the repo. `jobFeed` persists arbitrary backend `summary` objects,
up to 50, with no per-item bound — so growth toward the ~5 MB origin quota is a normal outcome, not
a pathological one.

Once `setItem` throws, the throw propagates out of the store action that triggered it. On the send
path that happens before the turn starts, so the composer never locks and no message is sent, with
no error surfaced. The same applies in Safari private mode, where `setItem` throws immediately.

**Fix:** wrap the persist write; on quota failure evict `jobFeed` and the oldest conversations, and
raise a banner rather than throwing into callers.

### H4 · Auth failure leaves the app permanently half-disabled

`src/auth/AuthContext.tsx:51`

The `.catch` sets a banner but never calls `setReady`. `ready` is a two-state flag over three states
(resolving / resolved / failed), and the failed state is indistinguishable from still-resolving. It
stays `false` for the life of the page, and `authReady` is a module-scope promise, so nothing
retries.

Everything gated on `ready` — sending, uploading, the session list, the transcript read, the job
streams — stays disabled behind a **dismissable** banner. Dismiss it and there is no remaining
indication of why the app does nothing.

**Fix:** model the three states explicitly and give the failure a terminal, retryable state.

### H5 · The SSE heartbeat suppresses itself when the last chunk does not end on a frame boundary

`server/proxy.ts:68`

`atFrameBoundary` is computed from the current chunk alone, so a frame terminator split across two
TCP chunks cannot be seen. Verified: `chunk.subarray(-2)` on a 1-byte buffer clamps to a 1-byte
view, so `tail.length === 2` is false and the boundary reads as mid-frame.

**Corrected from the original finding**, which claimed this disables the heartbeat "permanently".
It does not: `atFrameBoundary` is recomputed on the next `data` event. The real exposure is
narrower but still real — if the **last** chunk before an idle period does not end in `\n\n`, the
heartbeat is suppressed for that entire idle period, which is unbounded. That is precisely when the
heartbeat exists to fire, and an idle SSE connection is what intermediaries reap.

**Fix:** track the boundary across chunks — carry the last two bytes forward rather than
recomputing per chunk.

---

## Unverified remainder — 70 findings

The fleet's verification stage never ran, and I hand-verified only the critical and high tier.
These 70 are **leads, not results**: on a codebase with this much documented deliberate design,
expect a substantial rejection rate.

| File                                                                                                                                                                                                                                                                                                                             | Findings | Severities  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| `server/index.ts`                                                                                                                                                                                                                                                                                                                | 8        | M×7 L       |
| `src/components/Composer.tsx`                                                                                                                                                                                                                                                                                                    | 5        | M×5         |
| `src/components/Sidebar.tsx`                                                                                                                                                                                                                                                                                                     | 4        | M×4         |
| `src/state/chatStore.ts`                                                                                                                                                                                                                                                                                                         | 4        | M×3 L       |
| `e2e/fixture-service.mjs`                                                                                                                                                                                                                                                                                                        | 3        | M L L       |
| `shared/events.ts`                                                                                                                                                                                                                                                                                                               | 3        | M M L       |
| `src/components/JobFeed.tsx`                                                                                                                                                                                                                                                                                                     | 3        | M M L       |
| `src/components/Molecule.tsx`                                                                                                                                                                                                                                                                                                    | 3        | L×3         |
| `docker-compose.yml`, `server/config.ts`, `server/proxy.ts`, `server/routes.ts`, `src/api/client.ts`, `src/App.tsx`, `src/components/AnswerBadges.tsx`, `src/components/MessageList.tsx`, `src/components/ui/dropdown-menu.tsx`, `src/hooks/useJobStreams.ts`, `vite.config.ts`, `src/components/chem/SkipLinks.tsx`, `start.sh` | 2 each   | mixed M/L/N |
| 11 further files                                                                                                                                                                                                                                                                                                                 | 1 each   | mixed       |

Two worth surfacing early because they concern the safety signalling this product exists for:

- **`src/components/AnswerBadges.tsx:44`** — the "needs expert review" pill, the confidence badge
  and the unsupported-claims disclosure are mounted by **no unit test and no e2e spec**. The only
  `review_required: true` in the repo is a store fixture. The contract regression that `events.ts`
  itself records — degraded answers rendering as confident ones — has no guard against recurrence.
- **`src/components/Prompts.tsx:78`** — confirming an approval reportedly drops focus to `<body>`
  and announces nothing, on the flow the product describes as irreversible and attributable.

## Coverage and confidence

Read in full by the fleet: all of `src/`, `server/`, `shared/`, `tests/`, `e2e/`, `scripts/`, and
the root build/container/CI configuration.

Where confidence is low:

- **No verification pass ran.** The 70 above carry only their author's confidence.
- **The backend is not in this repo and was not running.** Claims about what FastAPI does on client
  disconnect — including whether a successful turn's transcript reliably persists after
  `streamTurn`'s post-answer `reader.cancel()` — could not be settled here and belong in
  `ISSUES.md`.
- **MSAL was never exercised.** C3 is a code-trace result, not an observed failure; the e2e suite
  cannot reach it in dev auth mode.

The pattern across all five criticals is worth stating plainly: **every one of them is in code that
no test executes.** Citation rendering, the BFF's error paths, the MSAL callback, the plan-gate
auth path, and multi-tab persistence are each individually reasonable-looking, individually
undertested, and collectively the whole confirmed list. The codebase's disciplined areas — the
event contract, the streaming loop, the token design, the design system — produced no confirmed
critical findings at all, which is consistent with where its tests actually point.
