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
**971 tests across 107 files**, up from 848, and `npm run build` emits.

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
  closed with the reasoning. The inbox's *read* is still a poll, deliberately: the stream carries a
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
