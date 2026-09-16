# Closing out the front-end review

Every finding from the review of 2026-09-04, worked to completion. The seven already fixed are in
`74e3f2c`; what follows is the remainder — 20 open defects, 15 feature gaps and 4 stale claims in
prose.

**The rule for all of it, from `CLAUDE.md`:** a step is done when its acceptance check passes _and_
`npm run lint`, `npm run typecheck` and `npm test` are green. Anything asserted about behaviour is
measured, not argued. Anything that turns out to be wrong is corrected in place and said so.

---

## Batch 1 — the BFF

- [x] **SIGTERM drains.** `server.close()` runs synchronously in the handler, so the listening socket
      is gone within ~300 ms while the router is still dispatching: measured, `/readyz` 200 →
      `ECONNREFUSED`. Set a draining flag that fails `/readyz` (leaving `/healthz` up, per this
      file's own liveness/readiness split), wait one readiness period, then close.
- [x] **`server.on('error')`.** `EADDRINUSE` bypasses the JSON-line config reporting entirely and
      prints a raw stack; the same emitter fires on `EMFILE` at accept time, so fd pressure is a
      crash rather than load-shedding.
- [x] **Refuse a path prefix on `CHEMCLAW_API_URL`.** `proxy.ts` and `ready.ts` use `hostname`/`port`
      and never `pathname`, so a service under a shared-ingress prefix starts clean and requests
      `/jobs` from the gateway root. Refuse it, in the posture this file already takes for
      `AUTH_MODE` and `MAX_MESSAGE_CHARS`.
- [x] **`headersTimeout` off a stale belief.** 125 s was pinned "just above the LB idle timeout",
      which stopped being how `headersTimeout` works before Node 14.11 — measured on this runtime, a
      500 ms `headersTimeout` serves a second request on a 1.5 s-idle keep-alive connection fine. It
      only needs to be `<= requestTimeout`. Lower it, and add `server.maxConnections`.
- [x] **Mint a correlation id at the front door.** Read off the _upstream response_ today, so every
      502, 499, 413 and `/api:blocked` line — the whole population during an outage — logs an empty
      one, and nothing joins a browser's `/client-events` report to the request that caused it.
- [x] **`unhandledRejection` / `uncaughtException` handlers**, and `.catch()` on the two `void`ed
      promises in the request listener.
- [x] **`refuseTooLarge` logs `route.template`, not `req.url`** — consistent with `app.ts`'s own
      refusal to use an attacker-chosen path as a metric label.

## Batch 2 — the chemistry and asset layer

- [x] **An SVG cache.** No LRU, no memo anywhere in `src/chem/`. Every _mount_ re-parses and redraws
      at ~5.9 ms per drug-like structure: switching conversations redraws the rail, the theme toggle
      redraws everything visible, one molecule in three places is drawn three times.
- [x] **A timeout on `loadRDKit`.** Not memoising the failure is right; having no timeout with it
      means a blackholed 6.9 MB wasm leaves the promise pending for ever and `SingleMolecule` renders
      a silent empty box for the life of the page. The sketcher already has one (60 s).
- [x] **Let the sketcher retry.** It memoises `null` permanently on a 7.71 MB chunk, where one
      dropped connection is not "a browser that cannot run the editor". Two seams, one fact, opposite
      answers — reconcile them.
- [x] **Stop claiming to terminate the Indigo worker** (the finding asked for either; only the
      second is available — see the Review below).
      ~~Terminate the Indigo worker, or stop claiming to.~~ `destroy()` unmounts the React root and
      nothing else; `ketcher-standalone` spawns its worker at module scope and never terminates it,
      so ~12 MB is retained after one Draw click while a comment says the heap is torn down.
- [x] **Split the routes.** `routes.tsx` statically imports `ReviewQueue`, `JobsPanel`,
      `ProtocolsPanel`, `ProtocolDocument` — ~50-60 kB of route code in a 635 kB entry for a chemist
      who only chats. `LazyMarkdown.tsx` has the loader+prefetch pattern to copy.
- [x] **Stop inlining a font subset into the render-blocking stylesheet, and preload the one face
      the first paint needs.** The subsetting half of this finding was not available — see the
      Review below.

## Batch 3 — render and click-latency performance

- [x] **Cache the `Intl.NumberFormat`s.** Measured 34.8 µs/call with options vs 0.70 µs cached — 50× —
      and the options branch is the one every chemistry payload takes. A 2,000-row result spends
      323 ms there alone.
- [x] **Cap the full result view.** `take` is the identity when not compact: every row rendered, plus
      a `flatMap(Object.keys)` over all of them. 2,000 rows = 970 ms and 20,400 cells.
- [x] **Cap the structure grids.** One `<Molecule>` per hit, all drawn as microtasks in one task with
      no paint between: 50 drug-like = 297 ms blocked and 514 kB of SVG; a 200-hit result ~1.2 s.
- [x] **`useMemo` the `ResultBlock` parse** (~10-30 re-parses of one payload per turn), and depend on
      `activity.kind` rather than a fresh `activity` object in `ActivityLine` (an effect scheduled
      60×/s to do nothing).

## Batch 4 — the store and the turn

- [x] **Give persistence a byte budget.** The count caps admit ~11 MB, over quota on every browser;
      `shedOldest` shrinks only what is written so the next flush re-does 37-55 ms of work, for ever;
      and at one conversation `Math.floor(1/2) === 0` writes an **empty** state and reports success,
      losing every other conversation silently.
- [x] **Stop persisting `streamedText` beside an identical `finalText`** — measured 2.09×, and the
      largest single contributor to the cliff above.
- [x] **Guard `migratePersisted` against a _newer_ version.** zustand calls `migrate` whenever the
      version differs, newer included, and both `if (version < n)` steps are then false, so a v4
      slice passes through unchanged into a renderer that throws. A rollback produces this.
- [x] **Key the detach-recovery writes.** `setComposerLock(false)` and `setBanner(null)` on the
      630 s poll bypass `releaseComposer`, which exists for exactly this and says so.
- [x] **Cross-tab storage.** Two tabs write the whole map every 750 ms; last writer wins wholesale
      and a conversation started in the other tab is gone on the next reload.
- [x] **Persist drafts.** In the store, absent from `partialize`.

## Batch 5 — the client contract the backend has outrun

- [x] **`SessionSummary.title` / `updated_at` / keyset paging.** The service sends all three; the
      client declares two fields, so every restored conversation reads "Earlier conversation" and
      sorts by _start_ time, and conversation #101 is unreachable. Closes `ISSUES.md` #4 and #7.
- [x] **Carry `result_ref` through the rehydrate.** Three lines. Without it every full tool result —
      the hazard table, the charge table, the solvent ranking — vanishes on reload, while
      `USER-STORIES.md` records A3 as served.
- [x] **Reconcile the local transcript against the server's.** Rehydration runs only when the local
      conversation is empty, so a reload during a ten-minute turn loses an answer the backend _did_
      write and `recoverDetachedAnswer` already knows how to fetch.

## Batch 6 — the capabilities with no surface

- [x] **The durable "waiting on you" inbox.** `GET /pending` + `POST /pending/{id}/answer`, with
      three live producers including a BO campaign that pauses at the bench. Gate the answer control
      on `asked_of`, not on the row existing.
- [x] **`DELETE /sessions/{id}`.** "Delete conversation" is a local map delete today, so the chemist
      who deleted it because it held something they did not want kept has been told a lie. Also: one
      click, no confirm, no undo, in a codebase that confirms everything else.
- [x] **Paginate the review queue.** `beforeId` existed with no caller; the service caps at 50 and
      nothing said the list was short. **The jobs half of this finding was wrong** — `list_jobs`
      takes `text` and `connector` and nothing else, so there is no cursor to follow and no cap to
      page past. Not built, rather than built against a parameter that does not exist.
- [x] **`GET /digests`** — read once at boot into the persisted feed, never polled from an effect
      that can unmount mid-flight, because the claim is destructive.
- [x] **`POST /sessions/{id}/fork`.**

## Batch 7 — the day-to-day gaps

- [x] **Copy an answer; print a protocol.** `navigator.clipboard` appears once in `src/` (the crash
      screen) and `@media print` nowhere, on the one artefact a chemist carries to the bench.
- [x] **An unsaved-work guard on the protocol editor** — the one screen where a human writes, and
      Escape or a click on the overlay discards the lot.
- [x] **Offline detection.** Every failure currently reads as a service problem.
- [x] **Deep links**: `/review/:proposalId`, `/jobs/:jobId`, `?revision=` on a protocol.
- [x] **Edit and resend** — refill the composer, leave the send to the human.
- [x] **Keyboard shortcuts** and a shortcut sheet.

## Batch 8 — the prose

- [x] Entry-chunk sizes in `chem/rdkit.ts` and `Molecule.tsx` (485/509 kB → 634.90 kB).
- [x] The sketcher chunk in `sketcher.ketcher.tsx` (3.4 MB → 7.71 MB).
- [x] `Sidebar.tsx`'s "the server has never sent one".
- [x] `chatStore.ts`'s "there is no resume endpoint".

## Deliberately not built

- **Bulk actions in the review queue.** The PR gate exists so a human reads each note; rejection
  needs a reason; every decision is confirmed because it is irreversible and attributable.
  Bulk-approve deletes the control. Bulk-cancel in the jobs panel is defensible but `cancelJob`
  answers 202, so it would need per-row outcome reporting to stay honest — and pagination is the gap
  people actually hit.

---

## Review

All eight batches are in. `npm run lint`, `npm run typecheck` and `npm test` are green —
**The suite and the build are green**; the counts that used to open this line said 971 across 107 files while the run reported 109 files, which is a claim about a commit rather than about the tree — `npm run test` is where a current number comes from.

### Five findings the work proved wrong

Worth more than the fixes, because each was a claim in the review that measurement did not support.
They are corrected in the code they concern rather than only here.

1. **The Indigo worker can be terminated.** The review said `ketcher-standalone` never terminates
   it and that a comment claiming otherwise was false. The comment was false; the rest was not —
   `IndigoService.destroy()` does call `worker.terminate()`. What is true is narrower and worse:
   the worker is a **module-scope singleton** every service shares, and `ketcher-react` never calls
   destroy, so terminating it is possible and **one-way** — the first close would leave every later
   Draw click mounting an editor with a dead backend. So the comment was fixed and the code was
   not, which is the opposite of what the finding asked for.
2. **`EMFILE` is not a crash.** The BFF was said to die under fd pressure for want of a
   `server.on('error')`. Driven at `ulimit -n 96` with 300 incoming connections: no `error` event,
   no exception, still listening. Node sheds what it cannot accept. The handler is still worth
   having — `EADDRINUSE` and `EACCES` are real and were producing an unparseable stack — but the
   crash it was said to catch does not happen.
3. **The font subsetting was half wrong.** 302 kB emitted for 88 kB fetched is real; "import only
   latin" is not available — `@fontsource-variable` ships no per-subset stylesheet, so it would
   mean hand-writing `@font-face` rules that duplicate generated output and risk the Greek glyphs a
   chemistry answer is full of. What _was_ real: Vite was inlining a Cyrillic subset as base64
   **inside the render-blocking stylesheet** (CSS 59,836 → 57,171 B) and there was no preload.
4. **The stale-read race reaches one panel, not three.** `JobsPanel` and `ReviewQueue` mount their
   sheets conditionally, so closing unmounts the state a late response would land in. Two attempts
   at a test for them passed against the _unguarded_ code, which is a test proving nothing. Only
   `NoteSheet`, which is re-targeted in place, is exposed.
5. **The `flatMap`/CSV cost in the result view was not a cost.** At 2,000 records the header union
   is 1.0 ms and `toCsv` 2.6 ms — 0.3% of that render. The cost is entirely DOM, so only the DOM is
   capped and the CSV stays over the whole set.

### Three numbers the review got close to exactly

The 429 loop (~1 req/s predicted, 1.008 measured), the abort-listener leak (~1,900 predicted, 1,931
measured), and the `Intl` cost (50× predicted, 47× measured).

### What is left, and why

- **The `awaiting-answer` push path is now closed**, and it took a change in both repositories:
  `D-2026-09-05-a-push-nobody-claims-is-not-a-push` widens the service's claim to a third kind and
  declares `AwaitingAnswerEvent`; this side mirrors it, routes the frame to its own store slice
  (not the job feed — a question held open for days is not a run that finished), badges `/review`
  with the open count, and re-reads `GET /pending` when that count moves. The backend's own contract
  tripwire fired inside the change and named this repository's normaliser in its failure message,
  which is the mechanical connection the two repositories previously had none of. `ISSUES.md` #9 is
  closed with the reasoning. The inbox's _read_ is still a poll, deliberately: the stream carries a
  notification, `GET /pending` carries the truth.
- **The 600-character SMILES cap bounds the unrecoverable failure, not the slow one.** A legal
  600-character chain still costs ~0.3 s to parse and ~1.7 s to draw on the main thread. Bounding
  that means a worker, which is a change of shape rather than a constant.
- **No cross-tab _live_ sync.** Writes now merge rather than replace, so nothing one tab did is
  destroyed by the other — but a conversation started in tab B does not appear in tab A until it
  reloads. That is a feature with a real question attached (rehydrating over an in-flight turn),
  and the sidebar already learns about other tabs' conversations from `GET /sessions`.
- **No retry ceiling on the sketcher chunk**, deliberately: every attempt is a chemist pressing a
  button, so nothing can loop, and a budget is something the one person on a flaky connection burns
  through — after which the editor is gone for the page's life, which is the defect restored.
- **Bulk actions**, argued against above and not built.

---

# Wave: one gate, and one rule about path segments

Two items, both structural. Neither is a cleanup — a survey of this repository found 0 TODOs, 0
`as any`, 0 empty catch blocks and error boundaries at two levels, and there was nothing to harvest.

## Item 1 — the gate was not reproducible, and two gates disagreed

- [x] **Every assertion that was inline shell is a named script.** `.github/workflows/ci.yml` ran
      four of them inside `run:` blocks — the `/config.js` reference, the MSAL entry-chunk probe
      with its positive control, `dist/server.js` from a `mktemp -d` with no `node_modules` — plus a
      whole `container` job of `curl`s. None had a name anybody could type, so in practice they were
      run by the pipeline and by nobody. They are now `scripts/check-bundle.mjs`,
      `scripts/check-standalone-server.mjs` and `scripts/check-serving.mjs`, each behind an
      `npm run check:*`.
- [x] **One definition, called by both pipelines.** `scripts/ci.mjs` holds the order and the reason
      for each step; `package.json` holds what each step _is_. `ci.yml`'s `check` job is `npm ci`,
      a browser install and `npm run ci`. `Jenkinsfile`'s Gate stage is `npm ci`, a browser install
      and `npm run ci` — it used to list six commands of its own with no `npm audit`, no contrast
      check and no browser suite, so a Jenkins-only estate was gated to a narrower bar than any
      document said.
- [x] **The container half is a named target that skips with a reason.** `npm run ci:container`
      builds the image and runs the four serving assertions; with no `podman`/`docker` it prints
      what it did not do and exits 0, and `CI_REQUIRE_CONTAINER=1` — which both pipelines set —
      turns that skip into a failure. `SKIP_IMAGE_BUILD=1` lets a pipeline build the image its own
      way (buildx with a layer cache in Actions; buildah/podman/kaniko in Jenkins) and still run the
      one copy of the assertions. The Jenkins "image serves" stage now calls
      `scripts/check-serving.mjs` directly against the artifact it is about to publish, which is the
      _stronger_ check that file already argued for and was making with its own hand-written
      `curl`s.
- [x] **`smoke` and `check:openapi` are decided rather than orphaned.** Both need a live Chemclaw3
      service and both exit non-zero when they cannot reach one, deliberately — `check-openapi.mjs`
      argues it in its own comments. They stay out of the offline gate and are `npm run check:live`,
      which is the named home they did not have. `tests/gate.test.ts` asserts both halves: in
      `check:live`, and not a step of `ci`.
- [x] **A test that catches the drift rather than describing it.** `tests/gate.test.ts`.

## Item 2 — the path-encoding invariant had six exceptions, not one

- [x] **Every interpolated path segment is encoded.** The finding named one site
      (`client.ts:538`, the XHR upload). Scanning for the _invariant_ found **eight segments across
      seven call sites in two files**: the upload, `stopTurn`, `getMessages`, both segments of
      `getToolResult`, `getPlan`, `decidePlan`, and the job event stream in
      `src/hooks/useJobStreams.ts`. All eight now go through `encodeURIComponent`.
- [x] **`tests/pathEncoding.test.ts` holds the rule, not the lines.** It parses every file under
      `src/` that can build a service URL with the TypeScript compiler and requires every
      path-segment interpolation to be an `encodeURIComponent` call, plus two behavioural tests that
      drive the fetch seam and the XHR seam with a hostile id.

---

## Review

Every step of `npm run ci` is green, and `npm run ci:container` asserts a real container. Each new
check was mutation-tested — the `/config.js` tag removed, `PublicClientApplication` pushed into the
entry chunk, the probe string made stale, an un-inlined import added to `dist/server.js`, and a
container started with a `CLIENT_DIR` that does not exist — and each failed for the reason it
exists. The numbers are in the commit message, which is about a commit; this file is about the
decisions.

### What the brief got wrong, and the measurement that showed it

The path-encoding item was described as "the **only** call site among eleven that does not
`encodeURIComponent` its path segment". Eleven is the count of sites that _do_; the count that do
not was six (eight segments — `getToolResult` has two). Fixing the one named line and pinning it
would have left an invariant with five other exceptions, which is not an invariant, and a reader
counting encoded sites could not have told which rule was in force. This is why the test is a scan
and not a pin.

### What the encoding actually changes

Nothing, for every id this app can legitimately hold: `server/routes.ts` matches a session id as 32
lowercase hex and a result ref as 64, so `encodeURIComponent` is the identity on both. What it
changes is the shape of the failure for an id that is not one. Driven with `a/b?c` as the session
id, the fetch seam requested `/api/sessions/a/b?c/messages` before the fix — a _different route_
with a query string, which the BFF whitelist forwards or refuses on its own terms — and
`/api/sessions/a%2Fb%3Fc/messages` after it, which the whitelist simply refuses. The value of the
rule is that it holds without anyone having to know which ids are safe.

### What is deliberately not done

- **`ci.yml` keeps two jobs.** One would be a single definition end to end, but the container job
  exists for its own runner and buildx's layer cache. Nothing is duplicated by the split: the
  `check` job runs `npm run ci`, the `container` job runs `npm run ci:container`, and
  `tests/gate.test.ts` fails if either grows an assertion of its own.
- **`npm run ci` does not install a browser.** Provisioning one is an agent concern and differs per
  pipeline (`--with-deps` needs root; this sandbox has Chromium at a fixed path and must not
  re-download). Both pipelines install it in the step before the gate.
- **The full-stack Playwright config stays out of the gate**, for the reason it was already out of
  it: it needs four repositories running.

---

# Wave: what an adversarial review found in the gate that was just merged

A fresh-context review of `11a2771` drove every claim rather than reading it, and found the
encoding half complete and correct (19 segments in `src/`, all encoded, no double-encoding, the
deep-link round trip exact) and **three of the new meta-tests passing with their subject deleted**.
That is the specific failure this wave is about: a test that cannot fail is worse than an absent
one, because it is counted.

## Item 1 — three assertions that passed with their subject broken

- [x] **`gate.test.ts` pinned a `console.log`, not a call.** `code()` strips comments, and the fix
      that introduced it was measured against a comment — but `check-container.mjs:75` _prints_
      `scripts/check-serving.mjs` in its skip branch, so replacing the real invocation with
      `{ status: 0 }` left the suite green and deleted the only end-to-end check that the proxy
      whitelist refuses `/api/metrics`. `tests/scriptInvocations.ts` asks the TypeScript parser
      which names are _arguments of a call_, skipping `console.*`; the Jenkinsfile half is pinned as
      a shell command line, since there is no parser to ask there. The docstring that claimed the
      defect was measured and fixed now says which half of it was.
- [x] **`delivery.test.ts` read the script's text for four probe strings.** `${base}/healthz`
      occurs twice in `check-serving.mjs` — once in the readiness loop, once in assertion §1 — so
      deleting §1 passed, while `/api/metrics`, which occurs once, was caught. No text-presence test
      can see `if (true)` put in place of `if (res.status === 404)` either. The four promises are
      driven now: the script runs against a healthy stub server and against four that each break
      exactly one promise.
- [x] **Nothing pinned `CI_REQUIRE_CONTAINER: '1'`.** The workflow sets it beside
      `CONTAINER_RUNTIME: docker`; the test pinned only the second, so deleting the line that _arms_
      the container job was green while the cosmetic half of the same env block was held.

## Item 2 — two guards that recognised a spelling rather than a shape

- [x] **The inline-assertion rule was a four-item blacklist.** `wget … | tee`, `node --eval "…"`
      and `test -f … || exit 1` all walked past it, the second being the `node -e` probe the rule
      names, three characters apart. The workflow's steps are an **allowlist** now — install, or run
      a named script — because every step there is of one shape. The Jenkinsfile stays a blacklist,
      widened, and says why in its own docstring: its shell legitimately builds, publishes and
      deploys, so an allowlist there would be re-approved on every delivery change until it meant
      nothing. The one allowlist that does carry into both: `node` may only run a file under
      `scripts/`.
- [x] **The orphan guard keyed on the `check:`/`check-` prefixes.** An unreachable
      `"verify:thing": "node scripts/verify-thing.mjs"` was invisible to it. It derives from shape
      now — an npm script that runs a non-tooling `scripts/*.mjs`, and every `.mjs` in that
      directory — with the four build/dev helpers named as the exception list, so a new script is an
      assertion until somebody writes it down.

## Item 3 — the encoding rule was a rule for template literals in two kinds of file

- [x] **String concatenation is scanned too.** `request('/jobs/' + jobId + '/artifacts', …)` is the
      same construct written the other way and passed the whole rule, with no ESLint error (neither
      `prefer-template` nor `restrict-plus-operands` is configured here).
- [x] **A `/api/…` literal is in scope wherever it is written.** `src/env.ts` makes `/api` the
      _default_ value of `apiBase`, so a new file could reach the service without ever naming the
      setting the scope predicate keyed on.
- [x] **A hoisted encode is no longer a false positive.** `const segment = encodeURIComponent(id)`
      was flagged with a message naming `encodeURIComponent`, so the cheapest way to green was to
      wrap it twice — and `a%2Fb` → `a%252Fb` reaches the service as a different id. A rule whose
      shortest fix is a defect manufactures defects.

## Item 4 — two things that were true of the tree rather than of a test

- [x] **`npm run ci` left `dist/client` carrying the dev auth provider.** The dev-auth build
      overwrote it and nothing rebuilt it — driven after a green gate: `assert-no-dev-auth` named
      `dist/client/assets/devAuth-BL8vWuWW.js`, and `npm start` serves that directory. The two
      artifacts have two directories now (`CLIENT_OUT_DIR`), and a final `dist-clean` step asserts
      the production one is clean. The ordering pre-dated the gate PR; what that PR changed was to
      make it the advertised one-command local gate, which is what put it in reach.
- [x] **`..%2F..%2F` reached the upstream still-encoded** through `NOTE`/`JOB`/`PENDING`, whose
      character class admits `.` and `%`. Harmless against a direct uvicorn + Starlette service,
      which decodes once into a `[^/]+` parameter — but that is a property of the _upstream_, and
      `server/routes.ts` stated it as a property of itself, while any ingress doing
      `UNESCAPE_AND_FORWARD` makes it real with this process being the one believed to have stopped
      it. `isTraversal` decides it here; driven through the real `createRequestListener()`, the
      four probes 404 and reach no upstream, and a Löslichkeit slug still passes.

## Item 5 — the two present-tense claims, and one known flake

- [x] **`check:live` is recorded as operator-run.** No pipeline calls it and none ever did, so
      `smoke` and `check:openapi` have a named home and no schedule. README and ISSUES said the
      orphan was solved; they now say which half. A test fails if either pipeline starts naming
      `check:live`, so the day it is wired in, the prose has to move with it.
- [x] **`resultCaps.test.tsx`'s 2,000-row test has a stated timeout.** Measured at 2,271 ms alone
      against vitest's default 5,000, which is not enough margin under suite contention — the review
      saw it time out during a concurrent container build. 20,000 ms, with the measurement in the
      comment, rather than an unnamed flake.

## What is deliberately not done

- **`check:live` is not wired into a scheduled workflow.** It needs a live Chemclaw3 service, which
  no push runner and no schedule here has; a job that cannot reach one would be permanently red or
  taught to pass without running, which is what those two scripts exist to refuse. So the decision
  is recorded in code and prose instead of being described as solved.
- **The Jenkinsfile's shell is not an allowlist**, for the reason above.
- **A NUL or a control character in a note id is still forwarded.** `%00` is not traversal, and
  widening the refusal to a character policy is a different change with a different blast radius
  than the one this review measured.

---

## Review

Everything above was driven. Each test added or changed was mutation-tested by breaking the
production code it protects, confirming red, and restoring from a backup kept outside the tree —
16 mutations in all, including the three from the review that reproduced exactly, and the
already-passing ones re-run to confirm no regression. The one "mutation" whose correct result is
green is the hoisted `encodeURIComponent`, which is correct code that used to fail.

# Wave 30 — the UI's share: a contract nobody checked, a name in two repositories, a record

## W30.1 — nothing checks the client half of the wire contract

- [x] **Read the backend, do not run it.** A check that needs a live service is a check that does
      not run (`check:openapi` has never once run in a pipeline). The sibling checkout is on disk;
      parse it. Resolved by `CHEMCLAW3_DIR`, else `../Chemclaw3`.
- [x] **Four axes**, each failing in the direction that costs a chemist something:
      the BFF whitelist against the routes the service registers; every event the backend declares
      against what `normalizeEvent` admits; every _field_ `normalizeEvent` reads against the fields
      the backend's model declares; every closed set the client mirrors (`ErrorCode`,
      `RefusalReason`, `AnswerCheck`) against the Python `Literal` it mirrors.
- [x] **What the client sends**, not only what it reads: every POST body in `src/api/` against the
      Pydantic request model of the route it posts to — six of which are `extra="forbid"`, so a
      stale key there is a 422 rather than a silent drop.
- [x] **Drive it.** Introduce a renamed field, a removed route and a renamed event; each goes red
      for its own reason, and the mutation is verified to have applied.
- [x] **Say what it cannot check**, in the test, in the readiness record and in `ISSUES.md`.

## W30.2 — `note_proposed` is not a proposal, and the name is a two-repo contract

- [x] Accept both wire names, old and new, with a test for each. Do **not** remove the old one.
- [x] Say in the commit, in `ISSUES.md` and in the contract check what the remaining step is.

## W30.8 — the production-readiness record

- [x] One document, every clause naming the test that holds it; a clause with no test is rewritten
      as an accepted risk or deleted. Every remaining open item into `ISSUES.md` with an anchor.

## Review — Wave 30, the UI's share

**W30.1.** `tests/backendContract.test.ts` + `tests/backendContract.ts`. Five axes, each failing in
one direction; eight mutations driven, each verified applied, each red for its own reason. The
backend checkout is read and never written: every upstream mutation was made against a copy under
the scratchpad and reached with `CHEMCLAW3_DIR`, which is also what proved that variable works.
What it cannot check is in `ISSUES.md` Issue 14 rather than implied.

**Two things the work found that were not in the brief.** Adding a 126th test file made two
`sendMessage` tests time out — they spun on an unbounded `while (!ready()) await sleep(5)` inside
vitest's default 5,000 ms and run in 6 ms alone, so they reported the stop path as broken whenever
the machine was busy; they are bounded now and carry the stated timeout four of their neighbours
already carry. And the contract reader's own `EVENT_TYPES` scan enrolled four words of prose as
event names, because an apostrophe in a `//` comment opened a quoted string — the same defect the
Python side of the same reader had already needed fixing for.

**W30.2.** The tolerant reader ships, the old name stays, and the remaining steps are written down
with who does each (`ISSUES.md` Issue 13). `AHEAD_OF_BACKEND` in the contract check is what reports
the day the service ships its half.

**W30.8.** `docs/production-readiness.md`, held by `tests/readinessRecord.test.ts`: a clause that
claims something and cites no file fails, a citation whose file has gone away fails, and an
accepted risk with nowhere to read the rest of it fails. Four mutations driven. The record is
linked from `README.md`, which the same test asserts.

**What was deliberately not done.** The contract check is not wired into either pipeline: that
means checking out a second private repository in the gate job, which is a credential decision
rather than a test change (`ISSUES.md` Issue 14). The path-encoding escapes are recorded rather
than closed — one needs dataflow analysis, the other a character policy with a different blast
radius than the traversal fix that was measured (`ISSUES.md` Issue 15).

---

## W30 review follow-up — what a fresh-context review of the merged wave found

Five things, each reproduced before it was changed and each mutation verified applied with
`git diff --numstat` before its result was believed.

- [x] **The contract check was red against today's backend, and the design said it could not be.**
      Chemclaw3 shipped Issue 13's step 2, so the _old_ wire name — the one step 3 deliberately
      retains until deployed browsers reload — became "dead code" by this file's own message, and
      the only mechanical remedy it offered was step 3 performed before the rollout: the ordering
      that loses the event. `RETAINED_FOR_ROLLOUT` makes a retained name a state rather than an
      error, beside `AHEAD_OF_BACKEND`, which holds the mirror-image one. The "step 3 is unblocked"
      notice was _unreachable in the only case it was written for_ — it sat after the throwing
      assertion in the same `it` — and now prints from the describe body.
- [x] **An argued entry cost nothing.** `['fake_event', '']` satisfied "argued", and the only
      expiry in the design was that unreachable notice. An entry now costs a reason of at least 40
      characters, a phrase that must occur in `ISSUES.md` (so closing the row retires the entry),
      and a review date that fails once it has passed. The validator is a pure function driven over
      a deliberately-wrong map, because the maps' normal state is empty and a loop over an empty
      map checks nothing.
- [x] **Three ways a claiming clause satisfied the readiness record's rule without naming a test.**
      Any `src/`/`server/`/`docs/` path counted; a clause indented under another was absorbed into
      it and never parsed; `§n` was a shape that never resolved. All three closed, and the
      shipped document needed no rewriting — measured first: every Enforced and Bounded clause
      already cites a test, and every `§n` already resolves.
- [x] **`tests/eventContract.test.ts` read the interface union while `shared/events.ts` says
      `EVENT_TYPES` is the gate.** Two lists described as one: a name in the gate with no interface
      and no branch produced zero failures. The two are now held to being one vocabulary, with an
      alias — a second wire spelling for an existing event — permitted and **pinned** by name.
- [x] **Not in the brief: a fall-through `case` was read as a branch that reads nothing.** So the
      run printed two fields of `note_recorded` as ones this client ignores (false), and axis 3 —
      the renamed-field drift — had nothing to compare for the one event a rename is in flight on.

**What this leaves open.** Nothing new. The review's other findings were driven and hold; the
`ISSUES.md` Issue 14 items (no CI lane checks the backend out, response shapes unchecked) are
unchanged.

---

## W30 follow-up 2 review — one claim in the record that was wrong

The round of fixes on top of `d2dc072` reproduced every finding before changing anything. One of
them is not a code defect and has nowhere else to be corrected, because the claim was made in a
commit message and a merged message cannot be edited:

- [x] **`git log -S` names where a phrase first appeared, not where it was duplicated.** The
      dedupe of the `tool_failed` comment in `shared/events.ts` (`052f77a`) attributed the second
      copy to `0a45516`. Walked every revision of that file, counting the sentence: `0a45516`
      takes it 0 → 1 and `17e7c09` takes it 1 → 2 — `git show 17e7c09 -- shared/events.ts` adds
      the second copy and leaves the first. The dedupe itself is sound and stands; only its
      provenance was wrong, and the rule worth keeping is that `-S` answers a different question
      from "which commit duplicated this".

---

## The check-in mailbox — a route the service served and nothing here read

`GET /check-ins` has been live upstream since the nightly check-in sweep shipped, and `check-ins`
occurred in **no file in this repository**: `tests/backendContract.test.ts` listed it, correctly and
silently, among the service routes the BFF does not forward. That list is the one this repository
already knows is dangerous — `/jobs`, `/proposals` and `/profiles` sat in it "looking like decisions
while being real gaps".

Built against the response model rather than against a description of it (`CheckInOut` in
`api/routes/streams.py`, and the sweep behind it in `durable/check_in.py`).

- [x] **The wire type, from the model.** `CheckIn` in `src/api/client.ts` — six fields, all
      defaulted upstream so all six always arrive. `listCheckIns` swallows a 404 into `[]` like
      every other list route and nothing else.
- [x] **The BFF forwards it.** One whitelist row; `tests/routes.test.ts` pins the forwarding and
      that a POST is not a path this proxy invents. `tests/backendContract.test.ts` no longer lists
      the route as unforwarded, which is the measurement that the gap is closed.
- [x] **The claim is once per page, into persisted state.** `useCheckIns` in `App.tsx`, latched at
      module scope before the request, exactly as `useDigests` is and for the same reason: the read
      is the _consume_, so a claim fired from the screen that displays it would destroy a notice
      for anyone who navigated away before it landed.
- [x] **A failure is carried to the surface, not only to the log.** This is where it departs from
      the digest path, and the argument is the asymmetry the service states itself: a lost digest
      leaves its notes merged and its watch saved, a lost check-in leaves a blocked question nobody
      hears about until it expires. `checkInClaim` is what lets an empty section say "nothing is
      blocked" only when the service actually said so — the confident emptiness `/review` has now
      deleted two sections over.
- [x] **A re-claim refreshes rather than dedups.** A digest's identity is its content; a check-in's
      is the question, and the sweep re-sends it nightly with one day less left. Keyed on
      `request_id`, the later numbers win, the position and the first-seen time do not move, and a
      dismissal survives.
- [x] **Proven end to end, not just per component.** `tests/checkIns.test.tsx` drives the store and
      all four render states (reading / nothing blocked / the claim failed / cards _and_ a failed
      claim). The path a component test cannot see — the shell claiming through the real BFF into
      the persisted store — is `e2e/routing.spec.ts`, against `e2e/fixture-service.ts`; the a11y
      pass now waits for the section before scanning, so axe covers it in both themes.

**What this could not do, and it is a finding rather than a shortfall.** Four things the sweep has
and the wire model drops: `kind` (so no badge), `session_id` (so no "open the conversation", which
both sibling inboxes offer), `truncated` (so this list cannot say it may be short, which
`PartialScan` does for plans), and any timestamp. Recorded as `ISSUES.md` Issue 16, because the fix
is somebody else's repository and inventing any of the four here would be worse than doing without.

**Run:** `npm run ci` — the whole gate, in the order `scripts/ci.mjs --list` prints — with
`CHEMCLAW3_DIR` pointing at the `Chemclaw3` checkout, so `tests/backendContract.test.ts` reads the
real response model rather than skipping with a reason. Not run, and neither is skippable by
choice: `npm run check:live` needs a live Chemclaw3, and `npm run ci:container` needs a container
runtime. No count of the suite is written here; the run prints one.
