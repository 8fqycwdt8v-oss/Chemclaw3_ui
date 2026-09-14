# Production readiness — what is enforced, bounded, measured and accepted

The record for `Chemclaw3_ui`: the browser client and the Node BFF in front of it.

**The rule this document is written under.** Every clause names the test that holds it. A clause
with no test is not softened into "we are careful about X" — it is rewritten as an accepted risk,
with who decides and what would change the answer, or it is deleted. That rule is itself checked:
`tests/readinessRecord.test.ts` fails if an **Enforced**, **Bounded** or **Measured** clause cites
no file; if an **Enforced** or **Bounded** clause names no file under `tests/` or `e2e/`, since
only a test can drive a refusal or a ceiling; if any file cited anywhere in this document does not
exist; or if a `§n` anywhere in it names a section this document does not have. A rename cannot
retire a citation here in silence, and a sub-bullet cannot hide from the rule by being indented.

**Three of those were added after the check was measured rather than read.** It said "names the
test" and accepted any file, so an **Enforced** clause citing `src/lib/utils.ts` passed; it started
a clause only at column 0, so a nested `  - **Enforced.** …` with no citation was absorbed into its
neighbour and never existed; and `§n` was a shape rather than a reference, so a section number
this document does not have anchored an accepted risk and read as filed. (That last sentence
cannot name the number it was driven with — the check now refuses it, which is the check working.) Each was driven, and each passed.

The four words mean different things and the difference is the point:

| Word         | What it claims                                                                 |
| ------------ | ------------------------------------------------------------------------------ |
| **Enforced** | Something is impossible, or refused, and a test drives the refusal.            |
| **Bounded**  | Something is possible and has a stated ceiling; the ceiling is asserted.       |
| **Measured** | A number somebody ran, with the conditions it was run under. Not a promise.    |
| **Accepted** | A real risk nobody has removed. It names who decides and what would change it. |

A fifth category is deliberately absent: "believed". Everything that was believed and turned out
not to be true is in the last section, because a control that has never been driven is
indistinguishable from one that does not work — and this repository has produced both.

---

## 1. The gate

- **Enforced.** There is one gate definition, `scripts/ci.mjs`, and neither pipeline may hold a
  second edition of it. `tests/gate.test.ts` fails if a step names an npm script that does not
  exist, if a GitHub workflow step is anything but an install or a named script, if either pipeline
  runs `node` on anything but a file under `scripts/`, if the Jenkinsfile's shell grows one of the
  assertion spellings, or if a script under `scripts/` is reachable from no composer — that last
  one by shape rather than by a `check:` prefix, so a `verify-*` script is held to it too.
- **Enforced.** The gate leaves `dist/client` free of the dev-auth provider. The dev-auth bundle is
  a second artifact in `dist/client-dev-auth` (`CLIENT_OUT_DIR`), and the gate's last step asserts
  the production directory is clean — `scripts/assert-no-dev-auth.mjs`, pinned by
  `tests/gate.test.ts`, which also asserts the ordering that makes it meaningful. Both directions
  run: a step that asserts the marker is **absent** from the production build, and one that asserts
  it is **present** in the dev-auth build, so a marker string that went stale fails rather than
  passing quietly.
- **Bounded.** What the gate does **not** run is named rather than implied: `npm run ci:container`
  (a second runner, a container runtime; it skips with a reason where there is none and
  `CI_REQUIRE_CONTAINER=1` turns that skip into a failure), `npm run check:live`
  (`smoke` + `check:openapi`, both of which need a live Chemclaw3), and
  `playwright.full-stack.config.ts` (four repositories). `tests/gate.test.ts` holds the live pair in
  both directions — in `check:live`, and not a step of `ci`.
- **Accepted.** `check:live` is operator-run and no pipeline calls it, so `npm run smoke` and
  `npm run check:openapi` execute only when a person types them against a live stack. A scheduled
  job would be permanently red (no runner here can reach a service) or taught to pass without
  running, which is the failure those two scripts exist to refuse. Recorded in `ISSUES.md` under
  "Known gaps in the UI rebuild"; `tests/gate.test.ts` fails if a pipeline starts naming
  `check:live`, so wiring it in forces this paragraph to move with it.
- **Accepted.** `npm run ci` does not install a browser. Provisioning one differs per pipeline
  (`--with-deps` needs root; this sandbox has Chromium at a fixed path and must not re-download), so
  both pipelines install it in the step before the gate. A machine with no browser fails at the
  `e2e` step rather than skipping it; the decision is recorded where the gate is defined
  (`scripts/ci.mjs`).

## 2. The wire contract with Chemclaw3

- **Enforced.** Every route the BFF forwards is one the service registers; every path and JSON body
  `src/api/` sends is one that service declares, down to the required fields of the Pydantic model
  behind it; every event the service declares survives `normalizeEvent`; every field that
  normaliser reads exists on the model that sends it; and every member of `ErrorCode`,
  `RefusalReason` and `AnswerCheck` survives the narrowing filter that mirrors it.
  `tests/backendContract.test.ts` reads all of that out of a `Chemclaw3` checkout
  (`CHEMCLAW3_DIR`, else `../Chemclaw3`) rather than off a running service.
- **Enforced.** Every member of the event union survives `normalizeEvent` carrying every field,
  checked by round-tripping a frame of each rather than by reading the list — the list is the thing
  that has been wrong six times (`tests/eventContract.test.ts`).
- **Enforced.** The runtime gate and the interface union are held to being **one** vocabulary,
  which this clause used to describe them as while only one of them was read. `EVENT_TYPES` is what
  admits an event; the fixture above is checked against the `ChemclawEvent` interfaces; a name in
  the first with no interface and no branch was invisible to every assertion in the file — measured
  at zero failures. A name in the gate must now normalise onto a declared member, and the one
  legitimate exception, an alias carrying a second wire spelling through a two-repository rename,
  is pinned by name rather than counted (`tests/eventContract.test.ts`).
- **Enforced.** A wire name this client admits and the service does not declare fails, unless it is
  argued — and an argument is a reason of at least 40 characters, a phrase naming the `ISSUES.md`
  row whose deletion retires it, and a review date that is a failure once it has passed. Two maps,
  because "not yet declared" and "no longer declared" are the same absence to a checker and
  different promises to a reader: `AHEAD_OF_BACKEND` is a reader that landed first,
  `RETAINED_FOR_ROLLOUT` is an old spelling kept until deployed browsers have reloaded. The
  validator is driven over a map built to be wrong in every one of those ways, because both maps
  are normally empty and a loop over an empty map checks nothing (`tests/backendContract.test.ts`).
  This part needs no sibling checkout, so unlike the clause above it runs in every lane.
- **Accepted.** With no sibling checkout the contract check verifies **nothing** and says so: a
  warning naming what the run is therefore not evidence about, and `CHEMCLAW3_REQUIRED=1` turns the
  skip into a failure. **No lane runs it as a gate by default, and this clause used to say one
  did.** The GitHub Actions runner — the lane that runs on every push — checks out this
  repository alone, so the check warns there. The Jenkins `Gate` stage does set both variables
  against the checkout its `Preflight` stage already makes, but that stage is behind a parameter:
  `RUN_GATE` defaults to `false`, so it is a gate only in a run somebody ticked the box on, and
  that lane builds and ships an image rather than answering a pull request. So the check gates for
  a developer or an agent with both trees, and in the four-repository full-stack lane, and nowhere
  else. What holds it back in the push lane is not a credential but the coupling: that lane would
  then red on a rename made in another repository. `tests/delivery.test.ts` holds this paragraph to
  the default the pipeline declares, so flipping the parameter fails here until the record is
  rewritten. Recorded in `ISSUES.md` Issue 14.
- **Accepted.** Response shapes are not checked. The client's interfaces for what it reads back are
  not compared to the models the handlers return: the mapping is not mechanical — one handler
  returns `list[SessionSummaryOut]` where the client reads a page plus an `X-Next-Cursor` header —
  and a check that guessed it would produce confident findings about a pairing it invented. What is
  covered is the three fields this has actually cost, driven end to end
  (`tests/contractDrift.test.tsx`). `ISSUES.md` Issue 14.
- **Accepted.** The check reads what the service **declares**, not what a deployment **serves**.
  `npm run check:openapi` is still the only thing that asks a running service, and it is
  operator-run (§1).

## 3. Path encoding, and its two escapes

- **Enforced.** Every path-segment interpolation in a file that can reach the service is an
  `encodeURIComponent` call — as an invariant over the tree, parsed with the TypeScript compiler,
  in both spellings (template literal and `+` concatenation), with a hoisted
  `const id = encodeURIComponent(raw)` recognised so that the cheapest way to green is not a double
  encode. Two behavioural tests drive the fetch seam and the XHR upload seam with a hostile id
  (`tests/pathEncoding.test.ts`).
- **Measured — escape 1: a path assembled off a named constant is invisible to the rule.** Driven
  on 2026-09-14: `const PROBE_BASE = '/api/jobs/'; fetch(PROBE_BASE + jobId)` in
  `src/hooks/useOffline.ts` passed the whole rule, while the same URL written as
  `fetch(\`/api/jobs/${jobId}\`)`in the same file failed it. The scan recognises a concatenation
whose **left operand is a string literal** ending in`/`; an identifier holding that literal is a
shape it does not see. Accepted rather than widened: chasing an identifier to its binding is a
dataflow analysis, and the rule's value is that it holds for the shapes this codebase writes.
`tests/pathEncoding.test.ts` is the rule; this paragraph is its boundary.
- **Measured — escape 2: encoding is not a character policy.** Driven on 2026-09-14 through
  `resolveRoute`: `/api/notes/note-a%00b` resolves and is forwarded as `/notes/note-a%00b`; so does
  the same id with `%0A`; so does `/api/jobs/qm%00-1`. A traversal does not — `/api/notes/..%2F..%2Fmetrics` is refused, by
  `isTraversal` rather than by the character class, and `tests/routes.test.ts` drives that in both
  directions. The wide `NOTE`/`JOB`/`PENDING` classes exist because those ids embed things this
  repository does not own (a slug a model wrote, a Temporal workflow id), and narrowing them to
  exclude `%00` is a different change with a different blast radius than the traversal one that was
  measured. **Accepted**, and it is the upstream's `[^/]+` path parameter that makes it harmless
  today, which is a property of somebody else's component.

## 4. The BFF

- **Enforced.** The proxy is a whitelist, not a pass-through: `server/routes.ts` matches method and
  a per-id-shape pattern, and everything else 404s without reaching the service. Session ids are 32
  lowercase hex, result refs 64, design ids `design-` plus twelve hex — which doubles as structural
  traversal protection, since a segment matching those cannot contain `/`, `.` or an escape.
  `tests/routes.test.ts` drives the shapes, the wrong verbs, the deleted routes that must stay
  un-whitelisted, and the traversal probes through the real request listener.
- **Enforced.** Header hygiene on the way upstream: the bearer token is forwarded verbatim,
  `cookie` and `proxy-authorization` are dropped, the service's own `X-Chemclaw-*` headers are
  dropped (a browser has no business setting them), and the `X-Forwarded` family is dropped because
  a browser can set it to spoof the edge. A caller with no credential sends no `authorization` at
  all (`tests/proxyAuth.test.ts`).
- **Enforced.** Header hygiene on the way back: the upstream cannot relax this origin's policy, and
  an upstream `Set-Cookie` or CORS grant is not relayed onto it (`tests/securityHeaders.test.ts`).
  A correlation id is minted at the front door rather than read off the upstream response, and a
  client-supplied one is never carried upstream (`tests/bffObservability.test.ts`).
- **Enforced — the SSRF posture is that there is no user-controlled destination.** The upstream is
  one address from configuration (`CHEMCLAW_API_URL`); the path is produced by the matched route's
  own `target`, never by the caller's string; a path prefix on that URL is refused at startup
  because `proxy.ts` and `ready.ts` use `hostname`/`port` and never `pathname`
  (`tests/serverConfig.test.ts`). There is no "forward to the URL in this parameter" surface to
  harden.
- **Bounded.** A request body is capped and refused before the upstream is contacted, an upstream
  that never answers is given up on rather than holding the socket for ever, and neither a held
  stream nor a hung request takes the whole `/api` surface down with it — the stream that does not
  fit is refused rather than queued, and the socket pool comes back without anyone intervening
  (`tests/serverLimits.test.ts`, `tests/upstreamPool.test.ts`, `tests/upstreamHang.test.ts`).
- **Bounded.** `POST /api/client-events` is unauthenticated by construction — the page that posts is
  served before sign-in — so the pod takes at most 600 batches a minute and answers the rest with a
  429 and a `Retry-After` the browser's sink waits out; a message full of newlines cannot forge a
  second log line (`tests/bffObservability.test.ts`, `tests/clientLogging.test.ts`).
- **Bounded.** Every metric label is the route **pattern**, never the id-bearing path, and no
  actor, session or correlation id is a label; an un-whitelisted path is bucketed rather than
  labelled with (`tests/bffObservability.test.ts`).
- **Enforced.** `/healthz` is liveness and stays a literal answer; `/readyz` probes the service's
  own and costs one upstream call however many probes arrive at once
  (`tests/bffObservability.test.ts`). A SIGTERM fails `/readyz` first and closes the listener after
  a readiness period rather than dropping in-flight requests (`tests/bffLifecycle.test.ts`).

## 5. Identity

- **Enforced.** An unrecognised `AUTH_MODE` is refused at startup, naming the value it was given,
  rather than resolving to `dev` — which is how `AUTH_MODE=MSAL` or a value with a trailing newline
  used to boot with no sign-in at all. Dev auth on a non-loopback bind is refused unless a
  deployment declares it (`tests/serverConfig.test.ts`).
- **Enforced.** In `msal` mode the BFF's readiness includes an auth-posture probe: a backend that
  serves an anonymous `/sessions` with 200 makes this pod **unready**, because an authenticated
  front end in front of an unauthenticated service is the deployment nobody notices
  (`tests/upstreamPosture.test.ts`).
- **Enforced.** The MSAL token cache is `sessionStorage`, so the token dies with the tab
  (`tests/msalAuth.test.ts`).
- **Accepted — the access token lives in the browser.** Any script on this origin can read it, and
  MSAL refreshes it through a hidden iframe to `login.microsoftonline.com`, a mechanism browsers
  are removing; the symptom when it goes is "people keep getting logged out", reported first by
  Safari and Firefox. The replacement (BFF token custody: stateless AES-256-GCM sealed cookie,
  `__Host-` prefix, chunked, three CSRF checks, ~1,500 lines of tests) is **built and not adopted**
  — PR #11, retained, to be reopened rather than rebuilt. **What would unblock it:** a
  confidential-client registration in the target tenant (a Web platform, a client secret, and
  `<origin>/auth/callback` as a redirect URI) plus two managed secrets with a rotation owner.
  **Who decides:** the tenant administrator for the registration, and whoever owns this app's
  operations for the secrets — not this repository and not a code review. Full reasoning in
  `ISSUES.md` Issue 8. This origin sets no cookies today, so there is no CSRF surface to defend
  (`tests/proxyAuth.test.ts` holds the `cookie`-stripping half).

## 6. One tab holds the job streams

`service_max_event_streams_per_user` is 5 per principal per process and has no idea what a tab is.
A leader election plus an interest protocol is what keeps two windows from spending six.

- **Enforced.** Every failure mode of the election is driven on real `BroadcastChannel`s in
  `tests/jobStreamElection.test.ts`: two tabs opening in the same millisecond (a campaign, not a
  lock — smallest id wins); the leader closing (`pagehide`, not `beforeunload`); the leader
  crashing with nothing announced (the lease, and negatively — one missed heartbeat must not depose
  a busy leader); the leader suspended or backgrounded; two tabs both believing they lead, with
  both directions of the total order driven, because a symmetrical rule is how an election ends
  with zero leaders and silent notifications; and no `BroadcastChannel` at all, where every tab
  leads — which is what this app did before and is safe.
- **Enforced.** The leader watches the **merge** of what every tab declares, round-robin by rank, so
  each window's first choice is taken before any window's second. Without it, measured: two
  windows, one stream for the account, the follower's conversation watched by nobody — the loss
  this whole feature exists to prevent, arriving from the direction the election does not look in.
  Both budget cases are asserted in opposite directions: a backgrounded leader trims what it asks
  for and must not trim what the account holds, while `jobStreamsThrottled` is evidence about the
  account and does cut the merged set (`tests/jobStreamElection.test.ts`).
- **Measured, and fixed — the starvation case.** `mergeWatchSets` took rank 0 and stopped at the
  budget, so with more interested tabs than the budget the tabs past `budget - 1` appeared at no
  rank at all — and since the peer order is a sort on a stable random id, it was the same tabs
  every time, for the life of the page. Driven at budget 3 with six windows: the same three
  sessions at t=0.5 s and at t=6 min, three of six conversations watched by nobody. The rotation is
  derived from the clock (`ROTATION_MS`, 60 s) rather than from a counter, and only rotates when
  starved. After: all six held over one cycle, three at a time (`tests/jobStreamElection.test.ts`).
- **Measured, and fixed — a hidden tab's interest.** Leadership and interest shared a 3 s lease
  refreshed by a 1 Hz watchdog, and Chrome's intensive throttling drops a hidden tab to one timer
  callback a minute. Driven, sampled every 500 ms over three minutes: **342 of 360 samples** had
  that window's conversation watched by nobody, each recovery spending a fresh connect against the
  cap. `INTEREST_LEASE_MS` is five minutes; after: 0 of 360. A follower that leaves politely sends
  an interest carrying no sessions, freeing its slot at once (`tests/jobStreamElection.test.ts`).
- **Enforced.** A relayed throttle is a report, not a decision: `jobStreamsThrottled` is evidence
  that _this_ tab 429'd twice and is deliberately irreversible, so relaying it pinned the whole
  account to one stream for the life of every page. The notice travels; the budget reads this tab's
  own flag (`tests/streamThrottleNotice.test.tsx`, `tests/jobStreamRateLimit.test.ts`).
- **Accepted.** A job ending read off a stream and not yet relayed dies with the tab that read it.
  The service's claim is destructive by design, so the row is gone from the mailbox before the
  browser has it; every client-side arrangement loses the same frame, and the fix is an upstream
  protocol change nobody has asked for. Bounded: the leader publishes synchronously inside the read
  loop, so for a tab that is merely closed the window is microseconds. `ISSUES.md` Issue 12.

## 7. Chemistry on the client

- **Measured.** Moving the toolkit to a worker took a 600-character draw from 587 ms of blocked
  main thread to 0 — measured by `scripts/measure-rdkit-placement.mjs`, **through the Vite dev
  server**, which serves `index.html` itself and sends none of the BFF's headers.
- **Accepted, and it outranks the line above: CSP has never let RDKit load behind the BFF, so no
  container-served deployment can observe that win.** `server/config.ts` sends `script-src 'self'
'wasm-unsafe-eval'`; `@rdkit/rdkit`'s Embind builds its invokers with `Function(...)` on the
  ordinary path, which needs `'unsafe-eval'`. Driven against the built bundle behind the real BFF:
  `EvalError: Refused to evaluate a string as JavaScript`, `toolkitLoads → false`, `drawSvg →
null` — and it predates the worker. A chemist sees every structure as text with "The structure
  toolkit could not be loaded" beside it, which reads as a deployment quirk because the degradation
  copy is correct. Two ways out, both posture rather than typo: `'unsafe-eval'` for the whole
  document (the origin that holds the bearer token and injects SVG with
  `dangerouslySetInnerHTML`), or serving the worker from a `blob:` so the relaxation is confined to
  a thread with no DOM. **Who decides:** whoever owns this app's CSP. `ISSUES.md` Issue 10.
  What is enforced meanwhile: the policy is pinned in both auth modes, including the absence of
  `'unsafe-eval'` and `'unsafe-inline'` (`tests/csp.test.ts`); the fallback degrades to text and
  says so (`tests/rdkitUnavailable.test.tsx`); and the worker is started and answers in a real
  browser (`e2e/worker.spec.ts`).
- **Enforced.** A dead or silent worker is not turned into "that is not a molecule": the client
  gives up on a worker that never replies and answers on the page, and a stack exhaustion is
  reported as a fact about a thread rather than as a chemical negative
  (`tests/rdkitWorker.test.ts`).
- **Accepted.** `canonicalSmiles` can answer `null` for a legal 600-character chain, depending on
  the JavaScript stack at the moment of the call rather than on length — measured three ways in
  `scripts/measure-rdkit-placement.mjs`, and it predates the worker. The cost is bounded and
  traced: a `null` is an omission, never a second identity, because every consumer drops the
  molecule rather than admitting it under its raw spelling, so no cache key, dedupe key or citation
  is ever minted from an uncanonicalised string. `tests/rdkitUnavailable.test.tsx` pins that bound
  by failing when either drop site falls back to the raw string. `ISSUES.md` Issue 11.

## 8. Routing and links

- **Enforced.** `/open/:sessionId` is the second-device link and says that is what it is. Sharing
  is **declined, not deferred**: every session-scoped route upstream resolves through an ownership
  check that 404s a non-owner indistinguishably from an unknown id, so a link handed to a colleague
  does not degrade — the conversation simply does not exist for them. Three user-visible strings
  used to promise otherwise. The old `/s/` path is not a redirect and not left to the catch-all
  either: it renders an explanation and goes nowhere, because falling through to `/` minted a fresh
  conversation and a reader saw an empty screen and read "mine was lost".
  `tests/routing.test.tsx` drives the adopted title, the truncated-link copy, the message on `/s/`,
  that the URL does not move, and that no conversation is minted — against what is **rendered**,
  because `routes.tsx` quotes all three old strings in the paragraph explaining why they are gone
  and a file-wide `toContain` would have passed with the change reverted.
- **Accepted.** A link copied before a session id rotates (a `session_not_found` recovery, a
  `resetSession`, a fresh conversation) points at a session the chemist has stopped using. That is
  the session handle being disposable, which is the same property that makes `/c/<local id>` the
  real URL. `ISSUES.md`, "the second-device link now says that is what it is".

## 9. What the browser keeps

- **Bounded.** Persistence has a byte budget rather than a count cap, and shedding shrinks what is
  written so the next flush does not redo the work; a migration from a **newer** persisted version
  is refused rather than passed through to a renderer that throws (`tests/persistBudget.test.ts`,
  `tests/persistQuota.test.ts`, `tests/persistence.test.ts`).
- **Enforced.** Two tabs merge rather than overwrite: neither erases a conversation the other
  wrote, and neither resurrects one this tab deleted (`tests/persistBudget.test.ts`).
- **Accepted.** There is no cross-tab **live** sync: a conversation started in tab B appears in tab
  A on its next reload. Rehydrating over an in-flight turn is the question that makes it a feature
  rather than a fix, and the sidebar already learns about other tabs' conversations from
  `GET /sessions`. Recorded in `tasks/todo.md` under "What is left, and why".

---

## 10. Controls found wanting during this programme, and fixed

This section is the evidence that the sections above are worth anything. Each of these was a
control that existed, was believed, and did not do what it said.

- **A whole gate that had never run.** `scripts/check-openapi.mjs` is the contract check, and it
  needs a live Chemclaw3: against a real backend it fetched a 404 and exited 1, so its one honest
  signal ("this check did not run") read as a mistyped base URL. `tests/backendContract.test.ts`
  reads the declaration instead, offline (W30.1).
- **Three meta-tests that passed with their subject deleted.** `gate.test.ts` pinned a
  `console.log` rather than a call — so replacing the real invocation of `check-serving.mjs` with
  `{ status: 0 }` left the suite green and deleted the only end-to-end check that the proxy
  whitelist refuses `/api/metrics`. `delivery.test.ts` read a script's text for four probe strings,
  one of which occurs twice. Nothing pinned `CI_REQUIRE_CONTAINER: '1'`, the line that **arms** the
  container job, while the cosmetic half of the same env block was held.
- **A path-encoding invariant with six exceptions.** The finding named one call site; scanning for
  the rule found eight segments across seven call sites in two files.
- **An inline-assertion guard that was a four-item blacklist.** `wget … | tee`, `node --eval "…"`
  and `test -f … || exit 1` all walked past it — the second being the probe the rule names, three
  characters apart.
- **A gate that left `dist/client` carrying the dev-auth provider.** Driven after a green gate:
  `assert-no-dev-auth` named `dist/client/assets/devAuth-*.js`, and `npm start` serves that
  directory.
- **An election that starved three of six windows for the life of the page**, and an interest that
  was dead for 342 of 360 samples in a backgrounded tab (§6).
- **A worker win no deployment can observe** (§7), found by trying to prove it in a real browser.
- **A contract-check reader that enrolled prose as a wire contract.** Added in W30.2: the
  apostrophe in a `//` comment inside the `EVENT_TYPES` literal opened a quoted-string scan, so
  four words of English arrived as event names. It strips comments now — the same fix the Python
  side of the same reader had already needed, which is why it was recognised.
- **Two tests that reported the stop path as broken whenever the machine was busy.** They spun on
  an unbounded `while (!ready()) await sleep(5)` inside vitest's default 5,000 ms budget, and each
  runs in 6 ms alone. Adding a 126th test file was enough to make both fail (W30.1).

## 11. What is accepted, in one list

Every one of these is argued above and recorded in `ISSUES.md` with an anchor:

| Accepted                                                                                                 | Where                     |
| -------------------------------------------------------------------------------------------------------- | ------------------------- |
| The access token is readable by any script on this origin; silent refresh runs on third-party cookies    | `ISSUES.md` Issue 8       |
| No container-served deployment can draw a structure, so the RDKit worker's win is unobservable there     | `ISSUES.md` Issue 10      |
| `canonicalSmiles` answers `null` for some legal long chains, depending on the JS stack                   | `ISSUES.md` Issue 11      |
| A job ending read off a stream and not yet relayed dies with the tab                                     | `ISSUES.md` Issue 12      |
| The old wire name `note_proposed` is still accepted, and must be, until the service ships the new one    | `ISSUES.md` Issue 13      |
| The contract check verifies nothing where there is no sibling checkout, and never checks response shapes | `ISSUES.md` Issue 14      |
| `check:live` is operator-run: `smoke` and `check:openapi` are on no schedule                             | `ISSUES.md`, "Known gaps" |
| A path built off a named constant escapes the encoding scan; `%00` in an id is forwarded                 | `ISSUES.md` Issue 15      |
| No screenshot baselines; no real MSAL redirect exercised; the sketcher canvas has no accessible path     | `ISSUES.md`, "Known gaps" |
