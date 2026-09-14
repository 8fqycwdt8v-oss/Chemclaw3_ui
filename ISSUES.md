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

## Closed: `/approvals` is deleted upstream, and so is this UI's half (was Issue 3)

This entry used to say the three routes "all exist in `routes/approvals.py`, every one gated by
`owned_approval`", with `ReviewQueue` as the surface. That was true when it was written and is not
now: `D-2026-08-27-a-hold-nothing-can-open-is-not-a-hold` deleted `GET /approvals`,
`GET /approvals/{id}`, `POST /approvals/{id}/decision`, the workflow behind them and the producer,
because **nothing in the service could ever open a hold** — three consumers with no producer, which
is what made the control look real.

This UI carried every consumer for a release after that: the proxy entries, `listApprovals` /
`decideApproval`, a whole "Holds waiting on a decision" section, and a branch in the inline card.
`listApprovals` swallowed the resulting 404 into `[]`, so the failure mode was not an error — it
was a confident, permanently empty inbox telling a chemist that nothing was waiting on them, under
a heading describing a decision that could not occur.

All of it is gone. `tests/routes.test.ts` pins the three routes as _not_ whitelisted, so
re-adding a consumer without the producer fails rather than shipping quiet.

**The half that was left open is now closed, elsewhere.** A pending plan approval used to survive
no reload: `state/transcript.ts` does not rehydrate `approval_request`, so the card was lost while
the service kept refusing every state-changing call, and the only recovery was to send another
message. The fix turned out not to need this page at all — `App.tsx` was already calling
`GET /sessions/{id}/plan` on exactly that path to restore the checklist, and throwing `approved`
away. It now carries it, and `chatStore.attachPlan` re-attaches the decision beside the plan.

**And the half that recovery could not reach is now this page's, on a route that did not exist.**
Restoring the card works for a conversation somebody opens; it answers nothing for a chemist who
closed the tab, because the session id is minted server-side and returned once. Every plan surface
was addressed by that id, so "which of my conversations is waiting on me" had no route to ask.
`GET /plans/pending` is it (`D-2026-08-28-an-inbox-asks-a-narrower-question-than-a-card` upstream),
and the section it fills is the one this entry left deliberately empty. Two things about it are
answers to what went wrong above: it lists a plan **nobody has decided**, not one with no live
approval — an approval is spent by the turn it authorized, so the looser predicate would have made
a permanently _full_ inbox of every finished conversation — and it returns `gated`/`unread` beside
the rows, so an empty list can say whether this deployment gates plans at all and whether the
service's scan was complete. `listPendingPlans` does not swallow its failures.

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

## Closed: `GET /sessions` now names and dates its sessions, and this UI reads them (was Issue 4)

`SessionSummary` was `{session_id, created_at}` and this entry asked for `title` and `updated_at`.
**The service added both**, exactly as proposed — `routes/sessions.py` constructs
`SessionSummary(session_id, created_at, updated_at, title)` from `page_for_owner` — and it also
added keyset pagination on an `X-Next-Cursor` header.

The client had outrun none of it and read none of it. Worse, `Sidebar.tsx` carried a comment saying
the guard against a server-supplied title "was decoration in front of a constant" because "the
server has never sent one" — deleted one release before it became load-bearing. So every restored
conversation read "Earlier conversation" until somebody clicked into it, sorted by when it was
_started_ rather than last touched, and conversation 101 was unreachable because nobody followed the
cursor.

All three are now read (`api.pageSessions`, `adoptSessions`, the "Load earlier conversations"
control), and `tests/contractDrift.test.tsx` pins each — including the fallback, so a service that
predates the fields still gets the placeholder rather than a blank row.

---

## Closed: the second-device link now says that is what it is (was Issue 5)

**Decided, and the decision was smaller than the analysis.** Two things this note used to say were
wrong in opposite directions, and both still stand as findings.

**Durability is better than assumed.** Under `session_store="postgres"` the session id is a durable
row in the ownership registry, and `deps._rehydrate_session` rebuilds a live handle over its
persisted history after an eviction or a pod restart — on the session's own profile, not the
default one. `service_max_live_sessions` (1000) bounds an in-process _cache_, not the session's
existence. A link does not die when the pod forgets the session. Under `session_store="memory"`
there is no registry and the link lasts one process.

**Shareability is worse than assumed.** Every session-scoped route resolves through
`_refuse_unless_owner`, which 404s a non-owner indistinguishably from an unknown id, deliberately.
A link handed to a colleague does not degrade — to them the conversation simply does not exist.

**What was decided: stop claiming otherwise, and do not build sharing here.** The route was `/s/`,
which reads as _share_, and three user-visible strings said it outright — the sidebar row read
"Shared conversation", a mistyped link was answered with "A shared link ends in a 32-character
session id", and the spinner said "Opening the shared conversation…". None of that is a phrasing
choice; it is this app advertising a capability the service refuses by design, to the one person
who will find out by sending the link to a colleague and being told the conversation does not
exist. The route is now `/open/:sessionId` and the copy says "Conversation from another device".

Three things about the shape of that decision, since the cheaper-looking options were both worse:

- **The old path is not kept as a redirect, and it is not left to the catch-all either.**
  Preserving `/s/` would preserve exactly the string the decision is about. Nothing in the UI ever
  offered the link for copying — its only entry points are two buttons in `/review`.
  **This row used to end by saying a stale one "lands on this app's own 'That conversation isn't on
  this device', which is the honest message anyway", and that was false.** `/s/` had no route at
  all, so it fell through `<Route path="*">` to `/`, which mints a fresh conversation: driven
  through the real `AppRoutes`, an old bookmark ended at `/c/<a new id>` with no error, nothing
  adopted and no mention of the link. A reader sees an empty conversation and reads "mine was
  lost" — worse than a 404, not better, and against the rule the e2e suite asserts by name ("an
  unknown conversation says so rather than redirecting"). `/s/:sessionId` now renders an
  explanation and goes nowhere, which is what the argument above needed in order to be true.
  `tests/routing.test.tsx` drives it: the message, the path it names, that the URL does not move,
  and that no conversation is minted.
- **Cross-person sharing is declined here, not deferred quietly.** It is not a client change: the
  404 is an _authorization_ decision, so a stable server-side conversation id would still be
  refused without an explicit grant beside it. That is a backend feature with a data model and a
  permission surface, and nobody has asked for it.
- **The rotation hazard stays, narrower than this note used to claim.** The client replaces the id
  in three places (`session_not_found` recovery, `resetSession`, a fresh conversation), so a link
  copied before one of those points at a session the chemist has stopped using. That is a property
  of the session handle being disposable, which is the same property that makes `/c/<local>` the
  real URL.

`tests/routing.test.tsx` pins the adopted title and the truncated-link copy against what is
**rendered**, not against the file: `routes.tsx` quotes all three of the old strings in the
paragraph explaining why they are gone, so a file-wide `toContain` would have passed with the
change reverted.

**What would change the answer:** somebody actually asking for cross-person sharing, which then
starts upstream rather than here.

---

## Closed: one tab holds the streams and tells the others (was Issue 6)

`service_max_event_streams_per_user` is **5**, enforced per principal per process, and it has no
idea what a tab is. `useJobStreams` budgeted 3, which fits one window and not two: a chemist with
two windows asked for six and the second window's last stream 429'd. The 429 path contained that —
two in a row drop a tab to a single stream for the life of the page — but handled is not prevented,
and a chemist with two windows watched fewer conversations than they thought.

This entry filed it rather than half-building it, and the reason it gave is the reason it took this
long: **a botched election loses notifications entirely, which is strictly worse than the contained
degradation.** A durable job runs for minutes to hours and its completion arrives once, on a stream
that must be open. So the failure modes were the work. `src/state/jobStreamLeader.ts` is the
election and `tests/jobStreamElection.test.ts` drives every one of them:

- **Two tabs opening in the same millisecond.** A campaign rather than a lock — a claim, 250 ms of
  listening, and the smallest id wins — so the pair agrees in one round trip instead of both
  winning and discovering it later. Driven with two real memberships over real `BroadcastChannel`s.
- **The leader closing.** `pagehide` (not `beforeunload`, which is documented unreliable on exactly
  the transitions that matter) broadcasts a resignation and every follower campaigns at once, so a
  handover costs one election window rather than one lease.
- **The leader crashing with nothing announced.** The lease expires and a follower campaigns. This
  is why the lease exists at all: a design that depended on `pagehide` would lose every
  notification after an OOM kill or a force quit. Driven, and driven _negatively_ too — a single
  missed heartbeat must not depose a busy leader.
- **The leader suspended or backgrounded.** Identical to a crash from the other side, deliberately:
  a frozen tab's timers do not run, so the survivor does not have to know which it was.
- **Two tabs both believing they lead**, which a woken tab produces by itself. Not prevented —
  converged on: the larger id yields on hearing the other's heartbeat. Both directions of that
  total order are driven, because getting it symmetrical ("somebody else leads, so I stop") is how
  an election ends with _zero_ leaders and silent notifications.
- **No `BroadcastChannel` at all.** Every tab leads, which is exactly what this app did before, and
  what it did before is safe. A feature that degraded to "nobody watches" would be the one
  unacceptable outcome.

**The half the election does not cover, and it had to be measured to be seen.** Electing a leader
says who opens streams; it does not say _which_ streams. `watchedSessionKey` reads this tab's own
`conversations` and its own `activeId`, and neither is shared — the store is hydrated per tab and an
active conversation is per window by definition. Driven: two windows, and the account held **one**
stream, for the leader's own session, with the follower's conversation watched by nobody. That is
the loss this whole feature exists to prevent, arriving from the direction the election does not
look in, and it would have shipped.

So every tab declares what it wants and the leader watches the **merge**, round-robin by rank, so
each window's first choice is taken before any window's second. Three streams for the account
instead of three per tab, and the two heads are always in it. A follower's periodic message _is_
its interest, and an interest expires on the same lease as leadership — a crashed tab stops holding
a slot for a window nobody is looking at.

Two budget cases run in opposite directions and both are asserted: a **backgrounded** leader trims
what it asks for and must not trim what the account holds, or a hidden tab would cut the chemist's
visible window to one stream; **`jobStreamsThrottled`** is evidence about the account rather than
about a window, so it does cut the merged set, which keeps the 429 backstop meaning what it did.

The relay carries stream _health_ as well as completions, because a follower holds no streams and
would otherwise be shown a working app while notifications were failing. And a takeover clears the
warnings it inherited: they described streams that no longer exist, and left alone they pinned a
red indicator on a healthy account until the page was reloaded.

**What is still true:** the 429 path is unchanged and is still the backstop, because two leaders
during a takeover and a browser with no `BroadcastChannel` both land back in the old shape. What a
takeover costs is a delay rather than a loss — the service writes job endings into `session_events`
and a row nobody has claimed is still there when the next stream opens.

---

## Closed: warmed sessions no longer fill the listing (was Issue 7)

The fix this entry called "better" is the one the service took: `list_sessions`'s docstring now
reads "Sessions that were created and never used are not listed at all". A warmed-and-abandoned
session costs an ownership row and nothing on screen.

What remains true and is _not_ a defect: `warmSessions` stays a `/config.js` flag, because it still
changes what a session means in aggregate and a deployment may want it off.

---

## Issue 8: the access token lives in the browser, and its refresh runs on a mechanism browsers are removing

**The posture, in four lines, so nobody re-derives it.** _Accepted:_ the access token stays in the
browser and MSAL keeps refreshing it through a hidden iframe. _Why:_ the replacement is built and
sound, and its blockers are operational rather than technical — see below. _What would unblock it:_
a confidential-client registration in the target tenant (a Web platform, a client secret and
`<origin>/auth/callback` as a redirect URI) plus two managed secrets with a rotation owner. _Who
decides:_ the tenant administrator for the registration, and whoever owns this app's operations for
the secrets — not this repository, and not a code review. Everything below is the evidence for
those four lines and does not need re-deriving; PR #11 is retained and is reopened rather than
rebuilt.

**Reviewed again on 2026-09-13 (W30.6) and unchanged.** Nothing in the tenant moved, so nothing
here moved. What _has_ changed since this was written is only the surface it worries about: this
origin now also runs RDKit on a worker (W28.7), which is one more thread of third-party code on the
origin that holds the token, and one more reason the second cost below is the one with a clock on
it.

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

## Issue 9 (closed): a question the agent is waiting on could not reach the browser by itself

**Repos:** Chemclaw3 (backend) and here. Closed 2026-09-05 by
`D-2026-09-05-a-push-nobody-claims-is-not-a-push` there and the mirror here.

`GET /pending` and `POST /pending/{id}/answer` were surfaced first — the "Questions waiting on you"
section of `/review`, added because the route has three live producers (the
`request_external_input` agent tool, `BoCampaignWorkflow._measure` pausing a campaign at the bench
for measured yields, and the connector-job path) and had no consumer at all.

**The push half was the part this repository could not fix.** `AwaitAnswerWorkflow._push` wrote an
`awaiting-answer` row into `session_events` (`durable/awaiting.py`) and
`GET /sessions/{id}/events` read with `kinds=("job_completed", "job_failed")`
(`routes/streams.py`), so the row was never delivered to any client — written, never claimed, aged
out under retention, and the claim is destructive and at-most-once, so there was no second chance
at it either. The only trace a chemist got was `record_job_started(handle.id, "awaiting")`, which
arrives as a `job_started` whose `kind` this UI does not recognise: an ask rendered as a durable job
that runs for a week and then silently expires.

**What closed it.** The backend claims the third kind and declares `AwaitingAnswerEvent`; this
repository mirrors it in `shared/events.ts` — the interface _and_ `normalizeEvent`, which rebuilds
every event field by field, so a field that does not reach it is deleted in transit rather than
merely ignored. `useJobStreams` routes the frame to `chatStore.noteAwaiting` (its own slice, not the
job feed — a question held open for days is not a run that finished), the sidebar badges `/review`
with the count, and the inbox re-reads `GET /pending` when the count moves.

Two properties worth keeping, both asserted in `tests/awaitingAnswer.test.tsx`: the badge comes
**down** on the expiry push, because a counter that only rose would advertise a question nobody can
answer any more; and the slice is **not persisted**, because the service is the authority on what is
open and a badge that survived a reload would outlive the answer.

That sentence claimed both were asserted and only the first was — a `partialize` that grew an
`awaiting` line would have shipped green — so the second is asserted now, against `partialize`
itself. Writing it also surfaced what non-persistence costs: the claim behind `awaiting_answer` is
destructive and at-most-once, so a reload replays nothing and the badge read **0** until somebody
opened `/review`, which is the screen the badge exists to send them to. `useAwaitingBadge` in
`App.tsx` reads `GET /pending` once per page for exactly that, beside the inbox's own read — an
ordinary GET, so reading it twice costs a request and destroys nothing, which is why the digest
claim next to it cannot be written the same way.

The slice itself is **request ids**. It carried `subject`, `kind` and `due_at` beside each id,
written by both producers and read by nobody: the badge reads `.length` and the inbox renders from
its own `/pending` response. That also removed a defect the brief had grown — `syncAwaiting`
compared ids only, so a `/pending` read correcting a `due_at` the stream never carried was
discarded as "unchanged", which is the one thing that function is for.

The half that stays a poll is deliberate and is not this issue: `GET /pending` is still read on
`/review` rather than pushed, since the stream carries a notification and not a projection.

---

## Issue 10: the CSP forbids what RDKit needs, so no container has ever drawn a structure

**Found by measurement, not by report** — W28.7 moved the toolkit to a worker, went to prove in a
real browser that a structure was drawn there, and found none is drawn anywhere.

`server/config.ts` sends `script-src 'self' 'wasm-unsafe-eval'`. That token permits WebAssembly
compilation and nothing else, which is exactly what its own comment says and exactly why it was
chosen. `@rdkit/rdkit` needs more: Embind builds every JS invoker for the C++ surface with
`Function(...)` — `craftInvokerFunction`, on the ordinary path rather than on a fallback — and
`'unsafe-eval'` is what permits that.

**Driven against the built bundle behind the real BFF**, loading the emitted RDKit chunk by hand:

```
EvalError: Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed
source of script in the following Content Security Policy directive:
"script-src 'self' 'wasm-unsafe-eval'".
    at Function (<anonymous>)
    at …/assets/RDKit_minimal-DP2qLPJt.js
```

and, driving the worker in its own protocol from the page: `toolkitLoads` → `false`, `drawSvg` →
`null`. **It predates the worker** — the identical probe fails the same way against the pre-W28.7
tree, on the page.

**What a chemist sees.** Every `<Molecule>` renders its SMILES as text with "The structure toolkit
could not be loaded, so nothing on this page can be drawn" beside it; the structure panel says the
same; the entity rail cannot key a compound, because `canonicalSmiles` answers `null`. The copy is
correct — the distinction `rdkitAvailable()` exists to keep is working exactly as designed — which
is why this reads as a deployment quirk rather than as a break.

**Why nobody saw it.** The Vite dev server serves `index.html` itself and never sends this header,
so `npm run dev` draws structures perfectly. `server/config.ts`'s own comment said to verify
against `http://localhost:3000` rather than `:5173`; nothing did, and the sentence beside it
asserted in the present tense that the directive was what RDKit needs. Both are corrected in place.

**Two ways out, and neither is taken here because both are posture rather than a typo.**

- **Add `'unsafe-eval'` to `script-src`.** One line, and it re-opens `eval` and `new Function` for
  the whole document — the origin that holds the bearer token, renders model output and injects
  RDKit's SVG with `dangerouslySetInnerHTML`.
- **Scope it to the worker.** A dedicated worker's policy is the document's in Chromium, so this
  is not a header on the chunk — it means serving `src/chem/rdkit.worker.ts` from a `blob:` built
  on this origin, or giving the worker its own document. More work, and it confines the
  relaxation to a thread with no DOM and no markup path. W28.7 is what makes it available at all:
  before it, the toolkit ran on the page and there was nothing to confine.

**What it costs beyond the drawing, which is the part that outranks the rest of W28.7's record.**
That wave's headline is a 600-character draw going from 587 ms of blocked main thread to 0, and
`scripts/measure-rdkit-placement.mjs` measures it through the **Vite dev server** — which serves
`index.html` itself and sends none of these headers. Behind the BFF nothing is drawn, so there is no
main-thread cost to have saved: the work W28.7 did is sound and **no container-served deployment can
observe any of it**. That is not an argument against the wave; it is the order the two should be
read in, and `src/chem/rdkit.ts` now says so beside the table rather than eleven paragraphs below
it. It also means this row, not the worker, is what stands between a chemist and a drawn structure.

**Who decides:** whoever owns this app's CSP. Until then `rdkit.client.ts`'s fallback is doing its
job — the app degrades to text and says so — and `e2e/worker.spec.ts` asserts the worker thread is
started and answers, which is the most this repository can assert today.

---

## Issue 11: a 600-character chain is inside the parser cap and `canonicalSmiles` still answers `null`

**Found by re-running W28.7's own measurement, not by report**, and it predates W28.7 — the same
probe behaves the same way against the tree before it.

`MAX_PARSED_SMILES_CHARS` is 600 and `tooLongToParse` is `length > 600`, so a 600-character chain is
inside the cap this module declares. That constant's own docstring states the rule it exists to
protect: a helper answering `null` for such a string "is saying _not a molecule_ about something
that is one". RDKit's canonical ranking recurses, so on a deep enough chain it raises
`RangeError: Maximum call stack size exceeded`, and on the main thread `withMol` turns that into the
module's ordinary negative. The negative is indistinguishable from a chemical verdict.

**Three measurements, all from `scripts/measure-rdkit-placement.mjs`:**

- Sweeping 300 → 600 characters in one page, `canonicalSmiles` **answered at every length** and
  blocked the main thread for 59–118 ms at 400 and above, one `longtask` each.
- Calling 200 then 600 in a fresh page, the same 600-character string **answered `null`**.
- The pre-W28.7 tree does the same: `null` at 600, after 147 ms of blocked main thread.

So it is not a length threshold at all — **it depends on the JavaScript stack at the moment of the
call**, which is why it has never been reproducible enough to be filed. The same string is a
molecule or is not, in the same browser, depending on what ran before it.

**What a chemist sees.** A long but legal structure renders as its SMILES with "not a recognised
structure" beside it, sometimes, and draws correctly the rest of the time — `moleculeSvg` is
unaffected and answered at every length measured. The entity rail cannot key such a compound,
because `canonicalSmiles` is what mints the key.

**Two things this also corrects about W28.7's record**, both in the direction of claiming more than
was delivered:

- The worker's boundary is between **300 and 400** characters, not "500 up". Above it,
  `rdkit.client.ts` re-runs the call on the page, so the main-thread block comes straight back and
  the wall clock is _worse_ than before the change — the worker attempt is paid first. The draw is
  the unambiguous win; canonicalisation of a long chain was never moved off the main thread.
- "The seam now answers identically at 200–600 characters in both placements" is true and is not
  reassuring: what it answers identically can be `null`.

**What it does not cost, traced rather than assumed.** A `null` here is an _omission_, never a
second identity: every consumer of `canonicalSmiles` drops the molecule rather than admitting it
under its raw spelling — `src/chem/entities.ts` at the tool-call path (`if (!canonical) continue`)
and at `ingestUserStructure` (`return null`), and `src/chem/structure.ts` likewise — so no cache
key, no dedupe key and no citation is ever minted from an uncanonicalised string, and a later
success merges on the same canonical key as every earlier one. The cost is what the paragraph above
says and no more: an intermittent gap in the rail, and an intermittent "not a recognised structure"
for a structure that is one. `tests/rdkitUnavailable.test.tsx` now pins that bound — driven by
making either drop site fall back to the raw string, it fails.

**Options, none taken here because each is a real decision:** lower `MAX_PARSED_SMILES_CHARS` to
something the ranking survives with margin (it would have to be measured, and it refuses structures
that draw fine); distinguish a `RangeError` from a chemical negative at the seam, so the surfaces
say "too complex to name" rather than "not a molecule" (the honest minimum, and it needs a third
value the module deliberately does not thread through today — see `MAX_PARSED_SMILES_CHARS`); or
raise the worker's stack, which is not configurable from here.

**Who decides:** whoever owns `src/chem/`. Until then the cap is a number that does not bound what
it claims to.

---

## Issue 12: a job ending read off a stream and not yet relayed dies with the tab that read it

**Found by re-reading the docstring against the service, not by report.** `src/state/jobStreamLeader.ts`
said, flatly, that "the gap during a takeover is a delay, not a loss … a row nobody has claimed is
still there when the next stream opens". The first half is the important one and it is true. The
sentence's scope was not.

The service's claim is destructive by design (`chemclaw/agent/session_events.py`, read at
`Chemclaw3` `1c2988fe`; that file itself last moved in `0bf7ff39`): one
`UPDATE … FOR UPDATE SKIP LOCKED … RETURNING`, documented as at-most-once, with `restore_unconsumed`
un-claiming a row whose _yield_ did not complete — which shrinks the loss window "to the transport
itself", in that module's own words. So a `job_completed` frame that has been written to a tab's
socket is already gone from the mailbox. If that tab dies between reading the frame and
`tab.publish`ing it, the completion reaches no window on the account, and no takeover, reconnect or
reload brings it back: the row is consumed and the job feed never held it.

**How big it is.** Small, and not zero. The window is the browser-side gap between the frame
arriving and `publish` running — the leader publishes synchronously inside the read loop, so for a
tab that is merely _closed_ it is microseconds. It widens for a tab the OS kills, a renderer crash,
or a laptop lid closing mid-frame. A durable run's ending arrives exactly once, which is the whole
reason this stream exists, so the cost of hitting it is a chemist never being told.

**Why it is not fixed here.** Every client-side arrangement loses the same frame: the row is gone
before the browser has it, so relaying earlier, retrying, or persisting sooner all start after the
only irreversible step. The fix is upstream — an acknowledgement before the claim, or a restore
keyed on _delivery_ rather than on yield completing. That is a service change with a protocol
attached, and nobody has asked for one.

**What was done instead:** the docstring now says which half of the promise it can keep. A file that
claimed "not a loss" about the one case it cannot cover is the thing worth removing immediately;
the loss itself is a known, bounded, upstream-shaped hole.

---

## Issue 13: the note event is renamed in two repositories, and the last step waits on a rollout

**Status: steps 1 and 2 are done. Step 3 is this repository's and is deliberately waiting — not on
a commit, on a rollout.** The event is not a proposal — nothing reviews a note any more
(`D-2026-09-05-the-gate-follows-behaviour-not-knowledge`) — so the accurate name is `note_recorded`,
and renaming an SSE discriminator is "a coordinated two-repo deploy with a skew window in which one
side silently drops the event".

An SSE discriminator is a contract two repositories switch on, and there is exactly one ordering
with no broken state:

1. **The reader accepts both names.** Done — `shared/events.ts` admits `note_recorded` in
   `EVENT_TYPES` and normalises it onto the internal `note_proposed`, so no surface has to learn
   the second spelling and none can miss it. Held by four tests in `tests/eventContract.test.ts`
   (old name, new name, the SSE `event:` line with no `type` in the body, and a near-miss name that
   must still be refused) and one on the real wire path in `tests/streamTurn.test.ts`.
2. **The service emits the new name.** **Done, and not this repository's step.**
   `src/chemclaw/api/events.py` upstream declares `type: Literal["note_recorded"] = "note_recorded"`
   and no longer declares the old spelling at all; its own model docstring records the ordering and
   says the third step "is theirs and happens after this ships".
3. **This repository removes the old name** — the `note_proposed` entry in `EVENT_TYPES`, the
   fall-through case, and at the same time renames the internal type. **Deliberately not done
   now**: every browser already loaded speaks the old name, so removing it before step 2 has
   _rolled out_ is the rename done in the order that loses events. The trigger is a deployment,
   which nothing in this repository can observe.

**How the contract check holds a step that waits on a rollout.** `tests/backendContract.test.ts`
compares the names this client admits against the names the service declares, and a name it admits
and the service does not is dead code — which `note_proposed` now looks exactly like. It is not,
and the difference is recorded rather than tolerated: the old spelling is an entry in that file's
`RETAINED_FOR_ROLLOUT` map, beside `AHEAD_OF_BACKEND`, which holds the mirror-image state (a name
this reader admits _before_ the service declares it). Both are held to the same discipline — a
non-empty reason, a phrase naming this row, and a date by which somebody re-takes the decision —
and an entry whose `ISSUES.md` row is deleted, or whose date has passed, fails. That is the expiry;
the old edition had none but a `console.log`.

**It does not fail the gate, and that is now true rather than intended.** The first edition argued
only the _new_ name, so the day the service renamed, the retained old name failed this file with a
message calling it dead code — the only mechanical remedy being step 3, performed before the
rollout, which is the event-losing order this whole entry exists to prevent. Measured against the
sibling checkout on 2026-09-14: one failed test, and the "step 3 is unblocked" notice it was
supposed to print never printed, because it sat after the throwing assertion in the same test.

---

## Issue 14: the contract check reads a declaration, and three things are outside it

`tests/backendContract.test.ts` (W30.1) is the first thing in this repository that compares what
this client sends and expects to what Chemclaw3 declares. What it covers is in
[`docs/production-readiness.md`](docs/production-readiness.md) §2. This entry is the other half —
what it does **not** cover — because a check whose boundary is unwritten gets read as covering
everything next to it.

- **No sibling checkout means no check at all.** It resolves `CHEMCLAW3_DIR`, else `../Chemclaw3`,
  and where neither exists it verifies nothing: the run prints a warning naming what it is
  therefore not evidence about, and `CHEMCLAW3_REQUIRED=1` turns that into a failure. It runs for a
  developer and for an agent with both trees, in the four-repository full-stack lane, and in the
  Jenkins `Gate` stage, which now sets both variables against the `.jenkins-lib` checkout its
  `Preflight` stage already makes. **In GitHub Actions it is still a warning**, and that is the
  lane that runs on every push.

  **The blocker this entry used to state was a credential, and it was wrong in both lanes.** The
  `Jenkinsfile` beside it falsified half of that on its own: `Preflight` clones `Chemclaw3`
  unconditionally on every run for the shared build library, so that lane had whatever credential
  it needs all along, and what was missing was the source paths the reader opens plus the two
  variables naming where they landed. Those paths are now derived from the reader itself by
  `tests/delivery.test.ts` rather than transcribed, so a reader that opens a directory the pipeline
  does not fetch fails there instead of quietly demoting the check to a warning; they are
  directories rather than files because `git clone --sparse` is cone mode, and cone mode refuses a
  file path outright. The other half is falsified by the repository itself — observed 2026-09-14,
  `8fqycwdt8v-oss/Chemclaw3` is **public**, so `actions/checkout` reads it with no credential at
  all and `GITHUB_TOKEN` never comes into it.

  **What is actually open is a coupling decision, and it is a real one.** Checking that repository
  out in the push gate points this repository's CI at another repository's moving `main`: a rename
  there reds every pull request here, including one that changed nothing, and the remedy is an
  argued entry in the maps above rather than anything the author of that PR did. That is the trade
  to take deliberately — it is what a contract check is _for_, and it is also a build queue nobody
  here controls. **Who decides:** whoever owns this repository's CI. It is not a credential
  question, and this entry should not have said it was.

- **Response shapes are not checked.** The interfaces this client declares for what it reads back
  are not compared to the models the handlers return. The mapping is not mechanical — `GET
/sessions` returns `list[SessionSummaryOut]` where the client reads a page plus an
  `X-Next-Cursor` header — and a check that guessed at the pairing would produce confident findings
  about a relationship it invented, which is worse than the gap. What exists instead is
  `tests/contractDrift.test.tsx`, which drives the three fields this has actually cost
  (`title`, `updated_at`, `result_ref`). **What would close it:** the handlers' return models being
  readable route-by-route, which is a shape the backend does not owe anybody today.
- **It reads what the service declares, not what a deployment serves.** A service serving something
  other than its source says is exactly the difference between this check and
  `npm run check:openapi`, which asks a live service and is operator-run (see "Known gaps" below).
  Neither replaces the other and both docstrings now say which is which.

Also outside it, and smaller: query parameters (dropped from every template on both sides), and
the BFF's own routes — `POST /api/client-events` has no upstream at all, so `src/lib/logger.ts` is
out of the reader's scope by name rather than by accident.

---

## Issue 15: two shapes the path-encoding rule does not see, and one it deliberately allows

`tests/pathEncoding.test.ts` holds the rule that every interpolated path segment reaches the
service encoded, as an invariant over the tree rather than as a list of call sites. Both escapes
below were **driven on 2026-09-14** rather than reasoned about, and both are accepted rather than
fixed — the reasoning is in [`docs/production-readiness.md`](docs/production-readiness.md) §3.

- **A path assembled off a named constant is invisible to it.** `const PROBE_BASE = '/api/jobs/';
fetch(PROBE_BASE + jobId)` in `src/hooks/useOffline.ts` passed the whole rule, while
  ``fetch(`/api/jobs/${jobId}`)`` in the same file failed it. The scan recognises a concatenation
  whose **left operand is a string literal** ending in `/`; an identifier holding that same literal
  is a shape it does not follow. Widening it means chasing an identifier to its binding, which is a
  dataflow analysis rather than a syntactic rule.
- **Encoding is not a character policy.** `/api/notes/note-a%00b` resolves and is forwarded
  verbatim; so does `%0A`; so does `/api/jobs/qm%00-1`. Traversal is refused — `isTraversal`
  decides it, not the character class, and `tests/routes.test.ts` drives both directions. The wide
  `NOTE`/`JOB`/`PENDING` classes exist because those ids embed a slug a model wrote or a Temporal
  workflow id, so narrowing them is a different change with a different blast radius than the
  traversal one that was measured. What makes a NUL harmless today is the upstream decoding it into
  a `[^/]+` path parameter — a property of somebody else's component, which is the reason this is
  written down rather than assumed.

**Who decides:** whoever owns `server/routes.ts`. **What would change the answer:** an ingress in
front of this process that normalises before the service (an Envoy with
`path_with_escaped_slashes_action: UNESCAPE_AND_FORWARD`, some nginx-ingress configurations) makes
the second one worth a character policy rather than a length cap.

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

- **One intermittent browser test, seen once and not reproduced.**
  `e2e/protocols.spec.ts:55` (`an edit becomes a new revision and comes back on the next read`)
  failed on the **mobile** project in one `npm run ci` on 2026-09-14 — `locator.fill` timing out at
  30 s waiting for `getByLabel(/^Temperature/)` after the Edit button had been clicked — and passed
  on the re-run of the same suite (91 passed, 5 skipped) and in isolation (12 of 12 in that spec,
  both projects). It is recorded rather than fixed because one occurrence does not say which of the
  two candidates it is: a lazily-loaded editor chunk under four parallel workers on a loaded
  machine, or the mobile sheet's open animation. **What would settle it:** the next occurrence, with
  the trace kept — `test-results/` holds an `error-context.md` per failure, and both runs above
  cleared it before anybody read it.

- **Screenshot baselines.** The axe pass covers the mechanical half of the visual contract; nothing
  guards a layout regression that is still accessible.
- **A real MSAL redirect has not been exercised against this router.** `/auth/callback` is
  structured so nothing writes the URL until `handleRedirectPromise()` has consumed the fragment,
  and the URL-sync effects live inside the `/c/:id` element rather than behind a pathname check, so
  they structurally cannot run on the callback path. The e2e suite runs in `dev` auth mode and
  cannot prove any of it.
- **`npm run smoke` against a real service.** The e2e fixture emits real time-gapped SSE frames
  through the real BFF, which is not the same thing as a real backend. It is now `npm run
check:live` together with `check:openapi` — deliberately outside `npm run ci`, because both exit
  non-zero when they cannot reach a service and a gate that is red on a laptop is a gate people
  learn to run past. `tests/gate.test.ts` holds that decision in both directions: they must be in
  `check:live`, and they must not be steps of the offline gate. Before this they were scripts with a
  name, a docstring and no caller at all.
  **What that did not do is make them run.** `check:live` is operator-run and no pipeline calls it,
  so these two still execute only when somebody types them against a live stack — which is what
  this row is about and why it is still open. `tests/gate.test.ts` fails if a pipeline starts
  naming `check:live`, so the day that changes, this paragraph has to change with it.
- **The structure sketcher has no accessible path, and will not get one here.** The canvas is
  Ketcher — a third-party WASM editor driven by a pointer. Radix's Dialog wraps the _chrome_ in a
  focus trap, an Escape handler and `aria-modal`; it does not make the drawing surface navigable by
  keyboard or legible to a screen reader, and nothing in this repository can, because the markup
  inside it is not ours. Making it accessible is an upstream change or a replacement editor.

  What is done instead is to stop the gap being silent. Drawing is one of three doors and the other
  two are text: the panel's SMILES field is labelled and reachable like any input, a `.mol`/`.sdf`
  drop reaches the same validation, and all three converge on one RDKit-canonicalised string, so a
  chemist who cannot draw is not locked out of anything — only out of the most convenient route to
  it. The dialog now says so in its `aria-description`, which Radix announces on open
  (`SKETCHER_ALTERNATIVE` in `src/components/StructureInput.tsx`), so the alternative is told rather
  than discovered.

  The axe pass excludes exactly one selector, `[data-sketcher-canvas]`, and scans the rest of that
  dialog including the sentence above (`e2e/a11y.spec.ts`). That exclusion is the honest form of
  this limitation: a gate permanently red on markup no commit here can fix is a gate people learn
  to skip, and the version of this that reads worse is a scan that quietly never visits the state
  at all — which is what it did before.

  **What would change the answer:** Ketcher shipping a keyboard-navigable editing mode, or a
  structure-entry route that is neither a canvas nor a string (a name lookup would be one, and
  `resolve_compound` is an agent tool with no HTTP route — see the module docstring).
