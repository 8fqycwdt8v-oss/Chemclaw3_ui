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

## Status

**All ten are fixed and pushed**, each with a regression test verified to fail against the commit
before its fix rather than merely assumed to. Green after every batch: typecheck, lint, format, 163
unit tests (up from 125), 46/46 contrast pairs, build, and `scripts/smoke.mjs` reporting frames
arriving incrementally — the check that guards the streaming path the proxy changes touched.

Playwright is green too — 47 passed — but only after a correction worth recording. This container
ships chromium r1194 while the pinned `@playwright/test` 1.62.1 expects r1234, so **every e2e run
in this session failed to launch a browser at all**, and the failure was invisible because the runs
were piped through `tail`: `$?` reported the exit status of `tail`, not of Playwright. Three
separate "e2e green" claims rested on that. The suite does pass, against
`executablePath: /opt/pw-browsers/chromium` — but it passed only once someone actually looked, and
the earlier claims were unfounded rather than merely lucky. The lesson generalises past this
container: never read `$?` through a pipe, and treat a gate that has never printed a pass count as
unrun.

C5 is resolved by a merge rather than a lock: conversations are keyed by id, so newest-per-id wins
and there is nothing to guess. `updatedAt` bumps on every token, which settles the case that
matters most — a turn streaming in this tab always outranks another tab's stale copy of it.
Deletion deliberately does not propagate; without a tombstone there is no way to distinguish
"deleted there" from "created here", and of the two possible mistakes, resurrecting a conversation
is recoverable and losing one is not.

### What the fixes revealed

- **H1 needed a store primitive that did not exist.** Retrying a turn means replacing the trailing
  failed pair, and nothing could remove a message. `prepareRetry` pops a `[user, failed assistant]`
  pair and returns the question, which both discriminates the banner's two producers and lets
  `sendMessage` re-append on its normal path instead of needing a second send path.
- **H4 was two bugs.** Beyond `ready` never reaching a terminal state, the "Sign in again" button
  it offered called `pendingAuth.login()` — a deliberate no-op — so the one failure that disables
  the whole app had a button that did nothing.

### Three bugs the fixes introduced, and one test that proved nothing

Reviewing the diff turned up three defects in the new code, all the same shape: a state change
that feeds back into whatever triggered it. None was in the original findings.

| Where           | The loop                                                                                                                                                                                                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cross-tab merge | `set()` → persist → `storage` event in the other tab → merge → write back. Each tab keeps its own `activeId`, so the snapshots never serialise identically and it never settles. Returning `{}` from the updater was not enough — zustand notifies on every `set()`, so the guard has to prevent the call. |
| proxy           | Stop destroys the upstream request on purpose, and the response emits `ECONNRESET` on the way out. The new error handler reported every Stop as a backend failure.                                                                                                                                         |
| persist quota   | The listener raises a banner; raising a banner is a `set()`; persist answers with another write; the write fails; it reports again.                                                                                                                                                                        |

And the regression test for the second was **vacuous on the first attempt** — it spied on
`console.warn`, but `server/log.ts` routes warn and error to stderr through `console.error`, so it
passed with and without the guard. It was caught only by running each new test against the unfixed
code, which is worth doing as a matter of course: that is the same false-confidence class this
review was looking for elsewhere, found in code written during the review itself.

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

## The remaining leads, verified

A verification pass ran the remainder against the corrected tree at `e116990`. **57 of the 70
returned a verdict: 41 confirmed, 3 already fixed by the ten fixes above, 10 rejected, 3 deferred
to the backend.** The 41 confirmations collapse to **35 distinct defects** — five were filed two or
three times by different agents (the sourcemaps, the `start.sh` port, the cache-control header, the
sidebar subscription, the composer upload state). Thirteen leads did not return a verdict and stay
unverified; they include both items flagged early last round — `AnswerBadges.tsx:44` (the review
pill has no test) and `Prompts.tsx:78` (focus after confirming an approval).

The outright rejection rate is 10/57, about 18%, and another 6 were already fixed or are not this
repo's to answer — so roughly a quarter of the leads were not actionable as filed, and duplicate
filings cost another six. That is the expected shape, not a disappointment: a codebase that writes
down its deliberate decisions gives an unverified fleet plenty of things that look wrong and are
not, and the cost of finding that out is exactly this pass. The more telling number is the
severity ceiling. **Nothing in the 41 is critical or high.** The first pass took everything that
was, and what is left is medium and below — real, worth fixing, and none of it load-bearing for
correctness of an answer.

### What has since been fixed

Of the 35 distinct defects below, **28 are fixed and pushed**, along with both dependency
advisories. `npm audit` now reports zero, `npm ci` installs `happy-dom@20` with no test changes
needed, and CI gained a blocking audit step plus a concurrency group. Every behavioural fix carries
a test verified to fail against the commit before it; the boot cases spawn the real built server,
which is the only way to reach a module whose side effects are `listen()` and `process.exit()`.

**Seven remain, and they are one coherent group: live-region and focus behaviour.**
`AnswerBadges` replaying every historical verifier alert on a conversation switch; `JobFeed`
mounting its live region and first card in the same commit, then re-reading the whole feed
atomically on every change; focus dropping to `<body>` after the last "Load earlier" and after
deleting a conversation; the 429 path firing two identical alerts and blurring the focused
textarea; and `InlineSmiles`' `aria-controls` pointing at a panel that only exists while expanded.
They are left together deliberately — they share one question (what should be announced, and when)
and answering it piecemeal is how live regions end up contradicting each other. The axe pass
cannot see any of them, so they need the screen-reader pass the e2e suite does not have.

One more is deferred with a reason: the sidebar still re-renders once per animation frame, because
`updatedAt` bumps on every token and any honest projection of it moves too. Not bumping per token
is the real fix, but that value is also the tiebreaker the new cross-tab merge depends on, so it
wants its own change. Each render is now cheap, which was the cost that mattered.

### Confirmed

| Sev | File                                 | What is wrong                                                                                                                                                                 | Fix                                                                                         |
| --- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| M   | `vite.config.ts:19`                  | `sourcemap: 'hidden'` drops the trailer but still emits ~4.8 MB of maps with full `sourcesContent`; the Dockerfile copies them and `sirv` serves them at `<bundle>.js.map`.   | `sourcemap: false`, or delete `*.map` before the runtime `COPY`.                            |
| M   | `server/index.ts:30`                 | A missing `CLIENT_DIR` kills the process — `sirv`'s eager `readdirSync` throws before `listen`, one line after a warning promising 404s. Hits `npm run dev` on a fresh clone. | Construct `sirv` only if the directory exists; fall through to the existing 404 handler.    |
| M   | `server/index.ts:49`                 | The no-cache guard tests the request path, so `/c/:id` and `/s/:id` — the URLs users actually reload — get a validator and no `Cache-Control`. Filed three times.             | Key the header off the served document: no extension ⇒ `cache-control: no-cache`.           |
| M   | `server/index.ts:99`                 | `requestTimeout = 0` for a reason that never applied (it bounds receipt, not the SSE response), leaving slow-body holds unreaped on the upload path.                          | `server.requestTimeout = 300_000` and reword the comment.                                   |
| M   | `server/index.ts:110`                | The only guard against a world-reachable sign-in-free front door is a `warn` log, deleted by `LOG_LEVEL=error`, while `config.ts` calls it a mirror of the backend's refusal. | Move it into `validateConfig` as a hard problem unless `UI_ALLOW_INSECURE=true`.            |
| M   | `server/proxy.ts:32`                 | At `maxSockets: 128` further requests queue with no socket, so the connect timeout never arms and nothing logs — every `/api` call hangs forever.                             | `maxSockets: Infinity`, and arm the connect timer before `.on('socket')`.                   |
| M   | `server/routes.ts:39`                | The approval-id length cap counts **percent-encoded** characters, so a long or non-ASCII hold id 404s at the proxy and renders as "not found".                                | Widen to `{1,512}` and say in the docstring that the cap is measured encoded.               |
| M   | `server/config.ts:91`                | Default `PORT` equals the default upstream port, so a bare `docker run` self-proxies, passes its own healthcheck, and answers `POST /api/sessions` with `index.html`.         | In `validateConfig`, reject a loopback `apiUrl` whose port equals `c.port`.                 |
| M   | `src/components/Sidebar.tsx:180`     | `SidebarBody` selects the whole `conversations` map, which gets a new identity every rAF while streaming; rows are unmemoised Radix menus. Filed twice.                       | Select a shallow-compared projection; `memo` `ConversationRow` with a stable `onSelect`.    |
| M   | `src/components/Composer.tsx:44`     | Upload state (banner, progress, Cancel, `AbortController`) is component state on a Composer that never remounts, so it follows the reader into the wrong conversation.        | Abort and clear `upload` in an effect keyed on `conversationId`.                            |
| M   | `src/components/JobFeed.tsx:53`      | The live region and its first card mount in the same commit, so the first background job completion is announced to nobody.                                                   | Render the `role="status"` wrapper unconditionally; early-return around its body.           |
| M   | `src/components/JobFeed.tsx:58`      | `role="status"` is implicitly atomic and wraps the whole feed, so dismissing one card re-reads the heading and every remaining card, SMILES included.                         | Make it a plain landmark and route one sentence per event through `announceStatus`.         |
| M   | `src/components/Composer.tsx:192`    | A 429 mounts two `role="alert"` regions with the same sentence in one commit, and disables the focused textarea.                                                              | Demote the composer notice to `role="status"`; move focus before disabling.                 |
| M   | `src/components/AnswerBadges.tsx:33` | `Notice` is unconditionally `role="alert"` and renders from persisted state, so a conversation switch fires every historical verifier alert at once.                          | Pass a liveness flag; `role="alert"` only for the live turn.                                |
| M   | `src/components/MessageList.tsx:306` | The last press of "Load earlier" unmounts the focused button, dropping focus to `<body>` with nothing announced and nothing visibly moving.                                   | Focus the oldest previously-shown `<article>` and announce the count.                       |
| M   | `src/components/Sidebar.tsx:162`     | Deleting a conversation destroys the menu trigger before Radix restores focus to it, and `preventDefault()` suppresses the fallback — focus lands on `<body>`, silently.      | Focus the adjacent row (or "New conversation") and announce the deletion.                   |
| L   | `docker-compose.yml:135`             | The `ui` environment block omits `WARM_SESSIONS`, `SSE_HEARTBEAT_MS` and `UPSTREAM_CONNECT_TIMEOUT_MS`, so ISSUES.md Issue 5's kill switch is unreachable under compose.      | Add all three as `${VAR:-default}`, matching the other operator variables.                  |
| L   | `start.sh:8`                         | Defaults the upstream to port 8000 unconditionally; every other source says 8080. The banner then prints the wrong target confidently. Filed twice.                           | Use 8080 (or drop the export), and fix the 8100/8099 comment on line 15.                    |
| L   | `docker-compose.yml:56`              | The header's "only the UI publishes a port" — the stated justification for the dev auth posture — is false: `temporal-ui` publishes 8233 on all interfaces, unauthenticated.  | Bind it to `127.0.0.1:8233:8080` and correct the header and README.                         |
| L   | `.env.example:2`                     | "Copy to .env for local use" is false: nothing loads a `.env` on either Node path, so `AUTH_MODE=msal` in a `.env` silently yields dev auth with no sign-in.                  | `node --env-file=.env`, or say plainly that only compose reads it, for interpolation.       |
| L   | `playwright.config.ts:46`            | `test:e2e` has no build dependency and reuses a running server locally, so a stale `dist/` passes green. CI is safe only because it builds first.                             | `"test:e2e": "npm run build && playwright test"`.                                           |
| L   | `server/config.ts:93`                | The `clientDir` default uses `URL.pathname`, so an install path needing percent-encoding resolves to a directory that does not exist — a hard boot failure under `npm start`. | `fileURLToPath(new URL('./client', import.meta.url))`, as `vite.config.ts` already does.    |
| L   | `server/proxy.ts:86`                 | The heartbeat uses one value as both interval and idle threshold, so the worst-case wire gap is ~2× `SSE_HEARTBEAT_MS` — the knob does not bound what it appears to bound.    | Tick at half the threshold, keeping the same comparison.                                    |
| L   | `shared/events.ts:183`               | `KNOWN_TOOLS` has zero consumers; the icons it claims to drive come from an unrelated literal in `toolIcons.tsx`, so following the comment ships a wrench.                    | Delete it, or retype `TOOL_ICON` as `Record<KnownTool, LucideIcon>` so they cannot drift.   |
| L   | `src/components/Markdown.tsx:57`     | react-markdown's hast `node` is spread onto the DOM: every link, `h3`–`h6` and inline code renders `node="[object Object]"`.                                                  | Destructure `node: _node` out in the three overrides.                                       |
| L   | `src/components/Molecule.tsx:37`     | `loadDrawer` caches the promise, not the result, so one failed chunk load permanently breaks every depiction on the page and blames the SMILES for it.                        | Null the cached promise in a `.catch` so the next mount retries.                            |
| L   | `src/components/Composer.tsx:176`    | The `#composer` skip-link target has no `tabIndex={-1}`, unlike its `#transcript` sibling, so on some browsers the skip link does not move focus.                             | Add `tabIndex={-1}`, or point the link at `#composer-input`.                                |
| L   | `src/components/Sidebar.tsx:194`     | The search filter is unmemoised and lowercases every message of every conversation in the render body — once per rAF while streaming, given the selector above.               | `useMemo` on `[needle, conversations]` and cache a lowercased haystack per conversation.    |
| L   | `src/components/JobFeed.tsx:35`      | Subscribes to the whole `conversations` map to read one title, re-rendering every frame — including when it renders nothing.                                                  | Read the title via `getState()`, or select a shallow-compared title projection.             |
| L   | `src/App.tsx:112`                    | `hydrateTranscript` guards only on the incoming array being empty, never on the local one, so a transcript read landing mid-send discards the user's message.                 | Re-check `conversation.messages.length` before replacing.                                   |
| N   | `src/index.css:166`                  | `--ease-out-quart` and `--ease-soft` are referenced by nothing and tree-shaken out of the build; they read as a house vocabulary that does not exist.                         | Delete both, or adopt one in the two transitions that would use it.                         |
| N   | `server/index.ts:101`                | No `'error'` listener on the server, so `EADDRINUSE` prints a raw stack in a file that otherwise prints clean `config:` errors.                                               | `server.on('error', …)` → log and `exit(1)`.                                                |
| N   | `server/routes.ts:39`                | The character class contains `:`, which the docstring's stated rule ("exactly what `encodeURIComponent` can emit") excludes; no test exercises the literal.                   | Drop `:`, or document why it is retained.                                                   |
| N   | `src/components/Molecule.tsx:160`    | `aria-controls` points at a panel that only exists while expanded, and collapsed is the default.                                                                              | Spread it conditionally, or keep the panel mounted and use `hidden`.                        |
| N   | `src/components/Molecule.tsx:137`    | An unbounded model-supplied SMILES becomes the image's accessible name inside JobFeed's live region; the inline path caps at 400 chars, the job path caps at nothing.         | Truncate the string used for `aria-label`/`<title>`, keeping the full text in the `<code>`. |

### Already fixed

All three by commit `13c29c7`, which added `src/state/persistStorage.ts`:

- **Per-frame localStorage writes** (`chatStore.ts:793`) — the persist storage is now a 250 ms
  trailing coalescer with a `pagehide`/`visibilitychange` flush; pinned by `tests/persistStorage.test.ts`.
- **Per-keystroke writes** (`chatStore.ts:797`) — same fix; `setDraft` bursts collapse to one write.
- **Token batcher duplicating text on a throwing write** (`sendMessage.ts:88`) — the write no longer
  happens on `appendTokens`' stack and quota failures raise a banner instead of throwing into callers.

### Rejected

Ten, kept here so the next review does not re-litigate them.

- **Documented and deliberate (3).** The floating `node:22-alpine` base (a patch-freshness tradeoff,
  with everything that breaks a build already lockfile-pinned); `api.request` spreading caller
  headers last (last-wins is the only way a caller can override `accept`, and no caller passes
  `authorization`); `EVENT_TYPES` being hand-maintained (the file header names that hazard, and the
  three lists agree 14/14 today).
- **Factually wrong (3).** CSP absent on `/api` responses is not an XSS hole — CSP is a document
  policy and every navigable HTML response comes from `sirv` with the full header set. An
  error-killed turn does carry an incompleteness label: `failTurn` sets `error` and `MessageList`
  renders it in a danger box under the text. Approval-id encoding was never broken client-side; the
  bug the tests record was the BFF's route pattern.
- **Describes a state the tree cannot reach (2).** The plan card's auto-send path does skip the
  `ready` gate, but no card renders an auto-sending button while `!ready`, and half the claim
  describes the dead "Sign in again" button that H4 already fixed. `migratePersisted` mishandles a
  version 4 payload that no build has ever written.
- **Duplicate of something already known (2).** The missing coverage provider (on the known list,
  and partly stale now that `tests/csp.test.ts` exists); the event contract's "four parallel lists"
  restating the `EVENT_TYPES` item above.

### For the backend

Three leads whose truth depends on the FastAPI service. Written to be moved into `ISSUES.md`.

**Does the service do any work after yielding the terminal `answer` event?**
`src/api/streamTurn.ts:98-112` breaks on the terminal event without draining to `{done: true}`, then
calls `reader.cancel()` on the success path. That disconnect propagates: `server/proxy.ts:207` sees
`res.writableFinished === false` and destroys the upstream request. If the handler's generator is
already exhausted this is a no-op; if the service persists the turn, settles budget, or releases a
lock after yielding `answer`, a normal successful turn is cancelled milliseconds before it commits.
Not answerable here — `GET /sessions/{id}/messages` 404s (Issue 2), so a systematically short
transcript would be invisible, and the e2e fixture's post-answer behaviour was written by this repo.
**Fix if confirmed:** drain to `done` on the success path, keeping the unconditional cancel for the
abort and error exits.

**Does the service keep emitting trace events after an `approval_request` hold?**
`src/state/chatStore.ts:683` trims each message's trace to `MAX_TRACE_ENTRIES = 200`, and the
Approve/Reject gate is read only from that array (`MessageList.tsx:75`). `latestPlan` is
deliberately hoisted out of the trimmed array; the approval is not. If 200+ further trace-producing
events can arrive on the same assistant message after a hold, a rendered approval card disappears.
**Fix if confirmed:** exempt `question`/`approval_request` from the slice, or hoist the latest one
beside `latestPlan`.

**What is `verifier_confidence_threshold` set to?**
`src/components/AnswerBadges.tsx:75` hardcodes its own tone bands at 0.8/0.5 while
`ReviewRequiredPill` renders straight from `review_required`, which `shared/events.ts:107-109` says
is `confidence < verifier_confidence_threshold`. If that threshold can exceed 0.8, an answer can
show a green "high confidence" badge next to a "needs expert review" pill. At any threshold ≤ 0.8
the contradiction is unreachable. **Fix if confirmed:** clamp the badge tone when `reviewRequired`
is true.

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
