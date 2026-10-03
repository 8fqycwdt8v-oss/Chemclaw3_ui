# User stories, and whether this frontend can serve them

**What this is.** Twenty-four workflows a chemist, a reviewer or an operator would want from
[Chemclaw3](https://github.com/8fqycwdt8v-oss/Chemclaw3) through this UI, derived from a read of
what the service can actually do — 25 HTTP routes, 15 SSE event types, ~56 agent-reachable tools,
28 skills, 20 durable workflows. Each story names the **aim**: the state the person is trying to
reach, not the feature they would click.

Then the part that matters: a verdict on whether **this** frontend serves that workflow well
today. Verdicts are grounded in source — a route in `server/routes.ts`, a field in
`shared/events.ts`, a component that exists or does not.

This is the sibling of `ISSUES.md`. `ISSUES.md` records defects; this records the gap between
what the service can do and what the browser lets anyone do with it.

---

## The finding

> **The SPA models the backend as a token stream with decorations. The backend stopped being that.**

The service now emits `result_ref`, `note_ids`, `numbers`, `verified_by` and `job_failed` on the
wire, and exposes twelve REST routes — `/notes/{id}`, `/sessions/{id}/tool-results/{ref}`,
`/proposals`, `/jobs`, `/profiles`, `/schedules` — several of which say in their own docstrings
that they exist _for a UI_. `GET /notes/{id}`:

> a surface that renders `note-…` tokens as citation chips therefore had nothing to resolve them
> against, so a citation was a highlight rather than a link.

That surface is this one. The UI's event contract and its BFF route whitelist both froze before
those arrived.

**As first written, of 24 workflows: 2 `SERVED`, 13 `PROSE-ONLY`, 5 `NO-UI`, 2 `DEFECT`,
3 `BLOCKED-BACKEND`.** Fifteen have moved since — see [What has changed](#what-has-changed) at the
end. The verdict columns below are kept current; the argument is not rewritten, because it is the
reason the work was chosen in this order.

Both `SERVED` stories are human-in-the-loop gates — answering a durable hold, approving a harness
plan — and both are genuinely good: confirmed, attributable, hash-bound, honest when they degrade.
That is not a coincidence, and it is the whole argument. **This frontend is excellent at the
workflows it was designed around (stream a turn, gate an irreversible decision) and near-zero at
the one the service has spent its last year building: returning structured scientific results.**

A superior user experience here is not more chat polish. It is rendering the data the wire already
carries.

### Verdicts

| verdict           | meaning                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `SERVED`          | The frontend does this well. Nothing to build.                                                                          |
| `PROSE-ONLY`      | The answer arrives, but as the model's _paraphrase_ of data the browser never receives. The ceiling is the chat bubble. |
| `NO-UI`           | Backend capability with no surface at all.                                                                              |
| `DEFECT`          | The frontend is wrong about the contract — the wire carries it, the UI drops it.                                        |
| `BLOCKED-BACKEND` | Needs work in Chemclaw3 first.                                                                                          |

`PROSE-ONLY` is the interesting one, and it is deliberately not `FULL`. The turn _succeeds_: the
chemist gets an answer and it is usually a good answer. But `screen_hazards` returns a
severity-sorted table of cited rules and the browser sees 200 characters of it; the rest reaches
the chemist as sentences the model wrote _about_ the table. For a hazard screen, an ICH limit or a
Pareto front, the difference between the data and a paraphrase of the data is the difference
between a record and a recollection.

---

## A — Ask, and be able to trust the answer

| #      | Persona and story                                                   | Aim                                                                                                                                                      | Backend                                                                                                                               | Verdict      |
| ------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **A1** | Process chemist: _"how was a coupling like this run before?"_       | A starting point grounded in our own ELN, with every claim traceable to the record behind it                                                             | `gather_evidence` over graph + ELN + fingerprint sources; `answer.confidence`, `unsupported_claims`, `review_required`, `verified_by` | `PROSE-ONLY` |
| **A2** | Reviewer: _"which note is that claim from, and is it still valid?"_ | Open the cited note with its provenance — `created_by`, `source`, `confidence`, `valid_from`/`valid_to` — and its neighbours, without leaving the thread | `GET /notes/{id}?hops=N` → `NoteView`                                                                                                 | **`SERVED`** |
| **A3** | Chemist: _"show me what the tool returned, not the paraphrase"_     | Read the hazard table, the charge table, the solvent ranking as data — and check the model did not round it                                              | `tool_result.result_ref` + `GET /sessions/{id}/tool-results/{ref}`                                                                    | **`SERVED`** |
| **A4** | Chemist: _"why did that turn stop?"_                                | Tell a wall-clock timeout from a loop cap from an exhausted budget, and know whether retrying is safe                                                    | `error.code` (a closed 8-value `Literal`), `error.retryable`, `error.correlation_id`                                                  | **`SERVED`** |

**A1.** The verifier surfacing is one of the better things here — `ReviewRequiredPill` sits _above_
the answer, not below it, and `unsupported_claims` are listed, and the score now says which verifier
produced it. Still `PROSE-ONLY` because the evidence behind the answer is a step away rather than in
it: the citations resolve (A2) and the tool results open (A3), but the answer itself is prose.

**A2.** ~~`CitationChip` cannot resolve anything.~~ **Built.** A chip opens the note, with its
provenance, its validity window and its neighbours, and warns when the window has closed — a
citation in an old answer can resolve to a note the graph no longer retrieves, and that is not
something a reader can infer. The old prefill survives as the failure path, because a `qm-…`
reference names a job whose note may never have been written.

**A3.** ~~The single biggest ceiling in the product.~~ **Built.** A trace row whose result was
stored offers "See the full result", which fetches it once and renders it: typed for the hazard
screen, the ICH lookup and the charge table, a generic table for anything shaped like records, and
the raw text otherwise. The preview stays — it is what makes the row scannable — and the panel is
what makes its numbers checkable.

A result **cut to fit the model's context** (`result_cut`, Chemclaw3 #473) is marked on its row —
"Result was shortened for the assistant — open full result" — and opens the full text the tool
returned as plain monospace text: size, copy and download of the whole, the first 64 KiB drawn, and
"no longer available — retention may have removed it" when the ref has been swept.

**A4.** ~~`ErrorEvent` carries only `message`.~~ **Fixed.** `code`, `retryable` and
`correlation_id` are read: a `budget_exhausted` arriving as an event now locks the composer exactly
as the 429 does, a failure the service marked retryable is offered a Retry, and the correlation id
is in the banner where it can be copied into a ticket.

---

## B — Compute a property, rank a series

| #      | Persona and story                                               | Aim                                                 | Backend                                                                                                                                                          | Verdict      |
| ------ | --------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **B1** | Process chemist: twelve candidate substrates, capacity for four | A defensible shortlist before booking lab time      | `compute_electronic_properties` (HOMO/LUMO, Mulliken charges, Wiberg bond orders), `predict_site_reactivity` (ranked atoms by Fukui index)                       | `PROSE-ONLY` |
| **B2** | Process chemist: pick a wash or extraction pH                   | Get the product into the right phase the first time | `predict_pka` (with `site` = acid or base), `predict_logd(smiles, ph)`                                                                                           | `PROSE-ONLY` |
| **B3** | Computational chemist: _"do we already know this molecule?"_    | Not pay for a calculation we ran in March           | `find_calculations`, `calculator_trust` (bias/MAE/RMSE/coverage), `calculator_outliers` (per-molecule residuals)                                                 | `PROSE-ONLY` |
| **B4** | Chemist: search precedent by structure, not by name             | Find the analogue whose name nobody remembers       | `similar_molecules` (ECFP4 Tanimoto), `substructure_matches` (SMARTS), `similar_reactions` (DRFP), `render_structure` (SVG for molecules _and_ `A>>B` reactions) | `PARTIAL`    |

**B1** wants a sortable table with a depiction per row. It gets a markdown list.

**B2** is a curve — logD against pH — delivered as three sentences. The chemist re-asks at a
different pH instead of dragging along an axis.

**B3.** `calculator_trust` and `calculator_outliers` exist so a prediction can be quoted with its
measured error, which is the difference between a number and a usable number. Note a rule that
applies across this whole section: several of these results carry a load-bearing `verdict` or
`summary` string, and an empty list means _"the index is empty"_ or _"the ledger is off"_ — never
_"no finding"_. Any renderer must put that string above the data.

**B4.** ~~A reaction SMILES falls through to raw text.~~ **Half built.** `Molecule` now draws a
reaction as its components with the agents over the arrow, so a `similar_reactions` hit and every
`reaction` note is legible. What is still missing is the input side: there is no structure editor,
so a SMARTS query is still typed into a chat box.

---

## C — Long-running work

| #      | Persona and story                                                 | Aim                                                                                | Backend                                                                       | Verdict      |
| ------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------ |
| **C1** | Chemist: submit a conformer or scan job and get on with the day   | Know it landed, be told when it finishes — **and be told when it fails**           | `job_started` / `job_completed` / `job_failed` on `GET /sessions/{id}/events` | **`SERVED`** |
| **C2** | Chemist: _"what is running, and can I stop it?"_                  | Kill a mis-launched durable job before it burns a worker slot                      | `GET /jobs`, `GET /jobs/{id}`, `DELETE /jobs/{id}` (reviewer role)            | **`SERVED`** |
| **C3** | Chemist: _"what did we run three months ago, and why?"_           | Reuse a result instead of re-running it — `job_records` keeps the launch rationale | `find_past_jobs`, `GET /jobs?text=&connector=`                                | **`SERVED`** |
| **C4** | Computational chemist: download the optimized geometry or Hessian | Take it into another package                                                       | `GET /calc-artifacts/content?ref={ref}` (the file) beside `list_artifacts`    | **`SERVED`** |

**C1 was the sharpest defect in this document, and is fixed.** `job_failed` was absent from
`EVENT_TYPES`, so `normalizeEvent` returned `null` and both consumers — the turn stream and
`useJobStreams` — dropped it silently. A durable job that failed rendered as _"Started qm job-… ·
runs asynchronously"_ and stayed that way forever: the chemist waited for a result that was never
coming, and the trace panel told them it was still running. It now renders as a failure with the
service's reason, in the trace and in the cross-turn feed, and the launch row's badge is retracted
on either ending rather than on neither.

**C2.** ~~There is no way to see or cancel a durable job.~~ **Built.** `/jobs` lists every run and
opens one; a reviewer can request cancellation. The wording never says the job stopped — the
service answers 202 and a workflow past its last cancellation point finishes anyway — which is the
difference between a control and a claim.

**C4.** ~~Needs a byte route on the service.~~ **Built** (artefacts wave 2). The service serves a
stored by-product's bytes at `GET /calc-artifacts/content?ref=<calc_key>#<name>`, with its stored
media type and filename, a 404 when the calc store has reclaimed it and a 413 above the
deployment's download cap. The BFF whitelists the path and holds the query to exactly one `ref` of
that shape (`CALC_ARTIFACT_REF`), because the resolver otherwise sees only paths. Every place the UI
shows a calc artifact ref offers **Download**: a `list_artifacts` result is a table of files with
their sizes, a `fetch_artifact` result marks a truncated read as _part of the file_ and offers the
whole one, and a geometry artefact that cites a calculation draws from — and downloads — the same
bytes.

---

## D — Safety before the bench

| #      | Persona and story                                 | Aim                                                       | Backend                                                                                                                                               | Verdict      |
| ------ | ------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **D1** | Process chemist: screen a mixture before ordering | A documented go/no-go, with the citation behind each flag | `screen_hazards` — 16 cited SMARTS rules across nine energetic classes plus pairwise incompatibilities, sorted by severity; `screen_genotoxic_alerts` | **`SERVED`** |
| **D2** | Analytical chemist: quote an ICH Q3C or Q3D limit | Put a limit in a document without fabricating it          | `ich_impurity_limit` — guideline, revision, table, and an explicit `limit: null` on a miss                                                            | **`SERVED`** |

**D1.** The service's strongest single capability, delivered through the narrowest channel it has.
And the caveat that carries the whole tool — _a clean screen is explicitly **not** a clearance_ —
is exactly the sentence prose loses when the model summarises.

**D2.** The ICH tables were added to the service specifically to kill a fabrication class a live
run measured, where the system recited a palladium PDE from training as though it were the record.
Rendering the lookup as prose, without the guideline and revision that make it a citation, re-opens
the hole the table was built to close.

---

## E — Design and optimise

| #      | Persona and story                           | Aim                                                                      | Backend                                                                                                                                                       | Verdict      |
| ------ | ------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **E1** | Chemist: _"what should I run next?"_        | Four conditions with an explore/exploit rationale defensible at a review | `suggest_next_experiment` — `predicted_value`, `predicted_sd`, the Pareto `front`, `campaign_id`, and `calc_refs` for the descriptors behind the search space | `PROSE-ONLY` |
| **E2** | Chemist: _"have we plateaued?"_             | Decide to stop spending on this campaign                                 | `campaign_progress` — best-so-far, running-best-per-evaluation series, evaluations since a real gain, plateau verdict; `assay_noise` required with no default | `PROSE-ONLY` |
| **E3** | Chemist: pick the campaign up next week     | Continuity across sessions and devices                                   | `resume_campaign(campaign_id)`                                                                                                                                | `PROSE-ONLY` |
| **E4** | Chemist: hand a screening design to the lab | A run sheet in run order, with what is confounded stated plainly         | `generate_screening_design` — full or fractional factorial, `resolution`, centre points, seeded run-order randomisation                                       | `PARTIAL`    |

A Pareto front is not a paragraph. A plateau is a series with a noise band. `campaign_id` is a
content hash the chemist currently has to select out of a chat bubble and paste back next week.

E4 has moved half-way: a design's run sheet renders as a table with a CSV download, so it stops
being retyped into Excel — which is where the transcription error enters a campaign. The
confounding banner, and the charts E1 and E2 want, are the obvious next batch: the panel and its
dispatch already exist, so each is a renderer rather than a feature.

---

## F — Governance and human-in-the-loop

| #       | Persona and story                                                                 | Aim                                                                                   | Backend                                                                                                                                                     | Verdict      |
| ------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **F1**  | ~~Chemist: answer a durable hold~~                                                | ~~An attributable, irreversible sign-off~~                                            | ~~`POST /approvals/{id}/decision`~~ — the mechanism is deleted upstream                                                                                     | **`GONE`**   |
| **F2**  | Chemist: approve the harness plan before it spends                                | Control what the agent is allowed to execute                                          | `GET /sessions/{id}/plan` + a decision bound to `plan_hash`                                                                                                 | **`SERVED`** |
| **F3**  | Chemist: find every decision waiting on me                                        | Nothing stays blocked because someone closed a tab                                    | `GET /plans/pending` → `{plans, considered, gated, unread}`                                                                                                 | **`SERVED`** |
| **F4**  | ~~Reviewer: review machine-written knowledge before it enters the graph~~         | ~~See the exact bytes that would land in the tree; approve, or reject with a reason~~ | ~~`GET /proposals`, `GET /proposals/{id}`, `POST /proposals/{id}/decision`~~ — the gate is deleted upstream                                                 | **`GONE`**   |
| **F5**  | Non-reviewer: do not offer me buttons that 403                                    | Not learn my permissions from an error message                                        | The `roles` claim; `entra_privileged_role_set`                                                                                                              | **`SERVED`** |
| **F6**  | Chemist: be told my own work is still blocked, before it expires                  | Chase the person who owes the answer while there is still time to                     | `GET /check-ins` → `[{request_id, subject, rationale, asked_of, open_days, days_left}]`                                                                     | **`SERVED`** |
| **F7**  | Chemist: decide a procedure the agent worked out and wants to keep                | Judgment that reshapes every later answer is mine to accept, and I see the document   | `GET /proposals` → `{proposals}`; `POST /proposals/{kind}/{name}` bound to `content_hash`                                                                   | **`SERVED`** |
| **F8**  | Chemist: see what judgment is acting on my answers, and remove it                 | The condition the stored skills tiers hold their exemption from review under          | `GET /skills/mine`, `DELETE /skills/mine/{name}`, `GET /skills/org` — read both tiers, remove my own                                                        | **`SERVED`** |
| **F9**  | Administrator: publish judgment to everyone, and put back what worked             | A bad deployment-wide skill is a rollback, not a re-authoring                         | `POST /skills/org`, `GET /skills/org/{name}/versions`, `POST /skills/org/{name}/revert`                                                                     | **`SERVED`** |
| **F10** | Chemist: work one problem in one conversation with a colleague, each as ourselves | Share the thread without lending my roles, my memories or my sign-off                 | `GET /sessions/{id}/members`, `PUT /sessions/{id}/members/{actor}`, `DELETE /sessions/{id}/members/{actor}`, `GET /sessions/shared`, `PlanStatusOut.author` | **`SERVED`** |

**F2 is what this frontend is for, and F1 no longer exists.** The plan decision is bound to the
hash of the plan that was actually rendered, fetched on card mount so the two cannot drift; a 409
re-reads the plan and returns to idle rather than blind-retrying with a new hash; the decision goes
through a confirmation that says it is irreversible and attributable; and against a service that
predates the plan route the card falls back to answering in the conversation _and says that is what
it is doing_. Nothing in this document asks for these to change. F1's durable "hold" was deleted
upstream (`D-2026-08-27-a-hold-nothing-can-open-is-not-a-hold`) because nothing in the service could
ever open one — see `ISSUES.md`.

**F3 outlived the route it was written against, because the aim was never about holds.** "Nothing
stays blocked because someone closed a tab" is a real story and the plan gate is what blocks work:
under `plan_only` every state-changing step is refused until a human approves, and until
`GET /plans/pending` existed that decision was reachable only from inside the turn that raised it.
**Built**, on `/review`, which is now what that page is for. It deliberately does not decide in
place — the service would accept it, since a decision is bound to the hash of the plan as
displayed, but a plan is approved on the strength of the reasoning that produced it, so the row
links into the conversation instead. What it adds over a bare list is that an empty one is never mute: the service
returns `gated` and `unread` beside the rows, so "this deployment has no plan gate", "the scan was
partial" and "nothing is waiting on you" are three different screens rather than one.

**F4 no longer exists, and it is the second story in this table to end that way.** It was built —
the queue listed what was waiting, and opening one showed the literal file content and every file
that would land beside it, as the file it is rather than as rendered markdown. Then Chemclaw3
deleted the PR gate itself (`D-2026-09-05-the-gate-follows-behaviour-not-knowledge`): knowledge does
not change what the agent does, so it is written directly and corrected — by provenance on every
retrieved chunk, by the citations a chemist checks at the point of use, and by contradiction — and
there is nothing left to approve before it lands. A **skill** is the opposite case, and the service
refuses outright rather than gating: no agent path writes a `SKILL.md`.

All three routes 404 today. This repo's client half went first; the whitelist rows and this row
outlived it, which is the same lag F1 had, and is why `tests/contractCheck.test.ts` now checks every
`SERVED` in this table against the routes the BFF can actually reach.

**F6 is the other direction from F3, and it was a served route nobody read.** F3 and the pending
inbox both answer "what is waiting on _me_". This one answers "what am _I_ waiting on", and the
service's own split is the argument for it being a fourth section rather than more rows in the
third: `durable/awaiting.py` re-notifies the person who has to answer, and writes to the person who
asked exactly once — on expiry. `awaiting_max_days` is 90, so a chemist could hear nothing about
their own suspended campaign for three months and then hear that it had failed. The nightly
check-in sweep closes that upstream; this is the surface that opens the mailbox, and before it
`check-ins` appeared in no file in this repository while `tests/backendContract.test.ts` listed the
route among the ones the BFF does not forward. **Built**, on `/review`. It carries no answer control
because there is nothing here to answer — the question is somebody else's. It links into the
conversation that raised it where there is one: `CheckInOut` carries `session_id` since upstream's
`D-2026-09-18-a-wire-model-cannot-drop-a-field-that-never-arrived`, and a wait opened by a plate run
or a connector job has none, so the link is absent rather than dead.

Not one of the original twenty-four, and stated rather than folded in for the reason section I
states it: the check-in sweep shipped upstream after this audit was written, so the counts in the
header stay as they were measured.

**F10 is new with Chemclaw3 #483, and the aim is in its second half.** Sharing a conversation is the
easy part; the service's decision (`D-2026-09-27-in-a-shared-session-the-sender-governs`) is that
it must not also share _authority_. Every message runs as its sender, so the transcript says whose
each question was once more than one person is in it. A plan is decided only by its author, so the
card names the author and disables the decision for anybody else — described by the reason rather
than hidden, because a plan card with no controls reads as a plan nobody has to answer. Deleting and
branching are the owner's, so a member is offered Leave instead of either; a 403 that arrives anyway
is said as the rule it is, never offered a retry. The owner admits by account id — an Entra object
id, shown as the service sends it, since there is no directory lookup here to turn it into a name.
F2 is unchanged for a conversation with one person in it.

**F5.** ~~`AuthAccount.roles` is parsed from the token and used nowhere.~~ **Built**, as
`useIsReviewer`. The role names cannot be hardcoded — they are a deployment's own — so they come
through `/config.js` as `REVIEWER_ROLES`, alongside the API scope. Controls are hidden rather than
disabled, and the screen says a reviewer role is needed, so nobody forms a judgement they then
cannot record. It is not enforcement and says so: the service decides, and will 403 regardless.

---

## G — Reports and corrections

| #      | Persona and story                                                 | Aim                                                                                                                   | Backend                                                                                                                                                        | Verdict      |
| ------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **G1** | Chemist: assemble a submission section from what we actually have | A draft where each paragraph is wikilinked to its source, and an unsupported section is _marked_ rather than invented | `request_development_report` — durable, per-section memory layer (`evidence` / `episodic` / `semantic`), renders only retrieved chunks, writes a `report` note | **`SERVED`** |
| **G2** | Chemist: correct the assistant when it is wrong                   | The correction survives, and contradicts the note that did not hold                                                   | `record_failure` (a `failure-mode` note with a `contradicts` edge), `record_confirmed_answer`                                                                  | `NO-UI`      |

**G1** is one of the service's best-served workflows — the report harness is purpose-built for
regulatory input, and keeping a _failed_ section visibly distinct from an _empty_ one is a real
piece of engineering. It arrives here as a `job_completed` event carrying a summary dict, and there
is no report viewer.

**G1, since the artefact pane.** A draft the agent writes _in a conversation_ now has a viewer: a
`document` artefact opens beside the answer, rendered through the same `Markdown` an answer is
(citations as chips, no raw HTML), versioned, editable as a revision attributed to the chemist,
exportable as `.md` and printable on its own. A figure in it that no tool in the session returned is
listed above it as _unchecked_. What is still `PROSE-ONLY` is the durable harness this story names:
`request_development_report` writes a `report` note and the UI still sees only `job_completed{summary}`
— the artefact pane does not open that note, and nothing on the service links the two. The verdict
stays where it is until one of them does.

**G1, since artefacts wave 2: `SERVED`.** The service now links the two. A report requested from a
conversation also lands there as a `document` artefact (author: the agent; id deterministic per
workflow, so a retried activity names the same one), `job_completed.summary` carries its
`exhibit_id` beside the `note_id`, and an `exhibit` push on `/events` refreshes the list. The job
card — in the trace and in _Finished in the background_ — shows **Open report**, which goes to the
conversation if the card is elsewhere and puts that artefact in front of the pane: rendered,
versioned, editable, exportable and printable like any document. A report the agent writes _inside_
a turn is watched being written: the document streams into the pane as `exhibit_draft` frames and is
replaced by the artefact when the tool returns.

**G2.** There is no feedback affordance anywhere in the UI. (`components/chem/Feedback.tsx` is a
spinner and empty-state helper, not user feedback.) The correction path exists on the service and
is unreachable from the browser.

---

## H — Continuity and platform

| #      | Persona and story                                                  | Aim                                                                          | Backend                                                                                 | Verdict            |
| ------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------ |
| **H1** | Chemist: use a cheap narrow agent for a lookup                     | Not pay for a full research loop to convert a pKa                            | `SessionIn.profile` + `GET /profiles`                                                   | **`SERVED`**       |
| **H2** | Chemist: reload and still see the agent's work                     | The trace survives a refresh from the _server_, not just from `localStorage` | `TranscriptMessage.tool_calls` — `tool`, `arguments`, `result`                          | **`SERVED`**       |
| **H3** | Chemist: send a colleague a link to this conversation              | A link that still resolves next month                                        | The session id is a disposable handle                                                   | `BLOCKED-BACKEND`  |
| **H4** | Chemist: be told when new ELN data matches a question I care about | Standing queries instead of re-asking                                        | `watch_for` / `list_watches` / `stop_watching` + `DigestWorkflow`                       | `BLOCKED-BACKEND`  |
| **H5** | Operator: is the ELN sync actually running?                        | Catch a silently failing sync before the agent goes stale for weeks          | `GET /schedules` — `last_run`, `runs_total`, `skipped_overlap`, `running_now`, `paused` | `NO-UI`, by choice |

**H1.** ~~The UI never sends a profile.~~ **Built.** `GET /profiles` is whitelisted and the
composer offers the choice — but only before the session exists and only when there is more than
one, because the profile is fixed on the service at mint time and offering it afterwards would be a
control that silently does nothing. The choice is re-applied on every later mint: a session is
replaced on `session_not_found` recovery and on reset, and a replacement that quietly dropped it
would move the conversation onto a different agent without saying so.

**H2.** The UI's `TranscriptMessage` is `{ role, text, created_at? }`. The service sends
`{ index, role, text, tool_calls }`. Two consequences: every tool call is dropped from a
rehydrated transcript, so reading a conversation back from the server loses the agent's work
entirely; and `created_at` is a field nothing populates — as is `SessionSummary.title`, which is
why every server-side session in the sidebar reads "Earlier conversation".

**H3** is `ISSUES.md` #4 and needs a stable server-side conversation id, distinct from the session
handle. The half of it that was about _a colleague_ is F10 now: a membership, not a link, is what
admits somebody, and a member finds the conversation under "Shared with me" without being sent one.

**H5 is left unbuilt on purpose**, and the reason is worth stating rather than leaving as a gap.
`server/routes.ts` excludes `/metrics`, `/schedules` and `/events/knowledge-merged` as operator
surfaces a chemist-facing BFF has no business proxying, and a test pins that exclusion. The story
is real — a silently failing ELN sync surfaces weeks later as "the agent doesn't know about recent
experiments" — but its audience is an operator with Prometheus and the service's logs, not a
chemist in this app. Reversing a documented boundary wants a better argument than one story.

**H4** exists only as agent tools. There is no HTTP route, so a watch can be created by asking and
then never listed or cancelled from the browser.

---

## I — Design an experiment, and correct it

**Not part of the original twenty-four**, and said so rather than folded in: the service grew a
protocol surface after this audit was written, so the counts above stay as measured. These four are
the stories that surface serves.

| #      | Persona and story                                                     | Aim                                                                                  | Backend                                                                                | Verdict      |
| ------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------ |
| **I1** | Process chemist: _"turn what I asked for into a protocol I can read"_ | A document to check line by line before anything is charged into a vessel            | `structure_experiment_request` / `draft_experiment_protocol` → `ProtocolReceipt`       | **`SERVED`** |
| **I2** | Process chemist: _"which of these numbers did I actually say?"_       | Tell an instruction from the agent's inference before agreeing to either             | `RequestField.basis` — `stated` (with the `quote`), `inferred`, `absent`               | **`SERVED`** |
| **I3** | Process chemist: _"the agent got the equivalents wrong; fix it"_      | Correct the document, attributably, without losing what it was corrected from        | `POST /protocols/{id}/revisions` with `parent_revision`; `409` when it is not the head | **`SERVED`** |
| **I4** | Chemist at the bench: _"where does each arm sit on the plate?"_       | Read the layout spatially — controls, replicates, run order — rather than as 96 rows | `PlateLayout` — `rows`, `columns`, `wells`, `randomized`, `seed`                       | **`SERVED`** |

**I1.** `/protocols` lists every design with its status and its blocker count; `/protocols/{id}` is
the document — request, conditions, charge, procedure, factors, run sheet, plate, analytics,
hazards, expectation, evidence, history. Laid out as a document rather than as a summary with
disclosures, on the grounds that a field one click away is a field nobody reads before ordering
reagents. The receipt also renders **in the answer**, as a `protocol` result block, with the arms
the service trimmed stated rather than left to be discovered.

**I2 is the story this screen exists for.** A protocol reaches a chemist as a mixture of what they
asked for and what the agent filled in, and `basis` is the only thing on the wire that separates
them. An inferred `scale` rendered like a stated one is the agent's guess wearing the chemist's
authority — and a scale is a vessel charge. So `inferred` says the word in a warn-toned chip,
`stated` carries the chemist's own sentence on a control a keyboard can reach, and `absent` says it
is not stated rather than showing a blank.

**I3.** A save posts the whole edited document with the `parent_revision` it was written against,
which is the same argument `plan_hash` makes on the plan gate: two chemists editing one design is
the ordinary case in a lab, and a save that silently rebased onto somebody else's revision would
discard their work while reporting success. The 409 is surfaced as _somebody else edited this_ with
a re-read, and the edit is never re-posted against the new parent. A change note is required before
Save is live, for the reason the review queue's rejection reason is.

**I4.** The map derives its row/column origin from the wells rather than assuming one — nothing on
the wire says whether `row` counts from 0 — draws a well the declared extent does not cover instead
of dropping it, marks a control with a ring and its own word rather than with a colour, and scrolls
inside its own focusable region so a 1536-well plate never scrolls the page.

**What is not served here.** There is no way to _start_ a design from this screen: a protocol is
drafted by asking for one in a conversation, and "Ask Claude to revise" fills the composer with a
sentence naming the design and its revision rather than composing a tool call from a click — the
line §9 of `docs/chemistry-aware-frontend.md` draws deliberately. The layout is also read-only:
hand-editing a well assignment would put the map and the arms out of step with nothing to notice.

---

## What this document does not claim

- **Nothing here was measured against a live service.** Verdicts are read off the two codebases —
  a route in a whitelist, a field in a union, a component that exists. The service's own
  `docs/reference/user-story-capability-map.md` audits the _scientific_ coverage of 106 stories and
  is the better source for whether the chemistry is there; this asks the narrower question of
  whether the browser can reach it.
- **`PROSE-ONLY` is not a failure verdict.** Thirteen of these workflows produce a good answer
  today. They are listed because the ceiling is low, not because the floor is broken.
- **Effort is not estimated.** But the shape is worth stating: seven of the nine non-`PROSE-ONLY`
  gaps are served by routes the service already has, and adding a route to `server/routes.ts` is a
  regex and a test. The expensive part is the rendering, not the plumbing.

---

## What has changed

This document was written as an audit and is being worked. What has shipped, and what each move
cost — kept as a record, because the argument for the next batch is that these were chosen the same
way.

| Shipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Stories it moved |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `job_failed` added to `EVENT_TYPES` — the event existed on the wire and was dropped in `normalizeEvent` — with a `JobFailureCard` in both places a job can end, and a launch row that retracts its "runs asynchronously" badge on either ending                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | C1               |
| `error.code` / `retryable` / `correlation_id` read, so a budget exhausted as an event locks the composer as the 429 does, a retryable failure is offered a Retry, and the reference is in the banner                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | A4               |
| `TranscriptMessage.tool_calls` declared and rebuilt into the trace; the phantom `created_at` removed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | H2               |
| `answer.verified_by` surfaced beside the confidence, because a judge's 0.82 is not a citation gate's 0.82                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | A1 (partly)      |
| `GET /sessions/{id}/tool-results/{ref}` whitelisted; a "See the full result" control on any stored result; typed renderers for the hazard screen, the ICH lookup and the charge table, a generic table for anything record-shaped, raw text otherwise — with the `verdict` always above the data it qualifies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | A3, D1, D2       |
| `GET /notes/{id}` whitelisted; a citation chip resolves to the note with its provenance, its validity window and its neighbours, and falls back to asking the agent when the reference is not a readable note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | A2               |
| ~~`GET/POST /proposals[...]` whitelisted; a `/review` screen showing the exact bytes a proposal would commit, its dependency files and its correlation id, with a rejection that cannot go out without a reason~~ — the PR gate was deleted upstream and the whole section with it; `/review` stays for the plan inbox and the held-open questions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | F4               |
| ~~`GET /approvals` given the inbox it always had a client method for, on the same screen~~ — the route was deleted upstream and the whole section with it; what stands in its place is `GET /plans/pending`, a cross-session inbox of undecided plans on `/review`, whose empty state names which emptiness it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | F3               |
| `GET/DELETE /jobs[...]` whitelisted; a `/jobs` registry that leads with the recorded rationale rather than the id, searchable over it, with a cancellation that is requested rather than claimed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | C2, C3           |
| The `roles` claim finally used, through `useIsReviewer` and a `REVIEWER_ROLES` runtime setting, to hide what would 403 instead of offering it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | F5               |
| `GET /profiles` whitelisted and a picker on a not-yet-started conversation, re-applied on every later mint so a recovered session does not silently change agent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | H1               |
| `Molecule` draws a reaction as its components with the agents over the arrow, so a `similar_reactions` hit is legible                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | B4 (partly)      |
| CSV download on any result the panel could table, quoted per RFC 4180                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | E4 (partly)      |
| The typed renderers lifted out of the panel into a shape-keyed registry (`src/results/`) and rendered **in the answer** as result blocks, fetched lazily and capped per turn — so the hazard table, the ICH limit, the charge table and a structure grid are at the same depth as the sentence about them, and the panel became the second look rather than the only one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | A3, B4, D1, D2   |
| A series renderer and one sparkline primitive, keyed on a run of numbers under any key, labelled with the key the service chose and no invented unit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | E2 (partly)      |
| The live activity row — plan step, open call, waiting job, elapsed — replacing "Thinking…" and the step counter; the trace disclosure now labelled with what the work was, and a step rail with per-step durations and a refusal counted as _held_ rather than failed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | A4, C1           |
| The three qualifier boxes ranked into one strip: an alert for what stops a reader acting, a chip for what they consult — with the method chip above the answer rather than in a footer below it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | A1 (partly)      |
| `GET /check-ins` whitelisted and claimed once per page into persisted state, with a fourth `/review` section for the caller's own blocked questions — the three states of the claim said in words, because a failed claim and an empty mailbox are the same empty array                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | F6               |
| Shared sessions (Chemclaw3 #483): the member routes and `GET /sessions/shared` whitelisted with an `ACTOR` segment encoded like a note id; a people panel (owner adds and removes, member sees and leaves); a "Shared with me" sidebar group; a sender label over each question once more than one person is in the conversation (`TranscriptMessage.author` read); a plan card that names its author and disables the decision for anybody else; Branch/Delete not offered to a member, and each 403 said as the rule it is                                                                                                                                                                                                                                                                                                                                                                                                                          | F10              |
| `GET/POST /protocols[...]` whitelisted and mirrored in `shared/protocols.ts`; a `/protocols` list and a `/protocols/{id}` document with basis chips, a plate map, a run-sheet CSV and a revision history; a field-level editor whose save is a new revision bound to its parent and whose 409 is a re-read rather than a retry; and a `protocol` result block in the answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | I1, I2, I3, I4   |
| Artefacts (code name `exhibit`, the frozen contract shared with Chemclaw3): every `/sessions/{id}/exhibits[...]` route and `GET /exhibits` whitelisted with an `XID` segment and a closed `FMT`; `shared/exhibits.ts` decoding every body with valibot and the `exhibit` event mirrored; a resizable right-hand pane, tabbed _Artefacts \| Index_ with the entity rail unchanged as the index, opened by the agent's new artefact and closed for the turn by the reader; a card in the answer; document, table, structures, chart, pinned-result and link views; a revision picker, a comparison through `RevisionDiff`, a 409 met with the diff and a choice; service exports plus SDF and SVG made here; _unchecked_ figures listed; Pin as artefact; `@artefact` chips sent as `exhibit_refs`; and `/artefacts` across conversations                                                                                                               | G1 (partly)      |
| Artefacts wave 2: a `geometry` kind drawn by a hand-written, dependency-free 3D viewer (ball and stick, covalent-radius bonds, orthographic painter's projection with depth cueing, keyboard and pointer rotation, an atom table as its accessible reading) from an inline XYZ block or a cited calc file; `GET /calc-artifacts/content` whitelisted with its query held to one `ref`, and a Download wherever a calc artifact ref is shown; `exhibit_draft` mirrored and streamed into the pane while a document is written, over an artefact being revised, replaced by the `exhibit` frame and discarded with a turn that has none; **Open report** on a report job's card; `invalid_exhibit_ref` read off the 422's code                                                                                                                                                                                                                          | C4, G1           |
| Artefacts wave 3: **bindings** — a table cell, a structure's SMILES or prop, or a chart series taken verbatim from a tool result, read off `raw_spec`/`bindings[]` and shown with a keyboard-reachable provenance marker (tool, JSON Pointer, result handle), read-only until **Detach**, with "source no longer available" for a binding whose result is gone and a chart captioned only for its transcribed series; and the **`html` kind in a sandbox** — the BFF's second listener on its own origin serving one page under a closed CSP, framed `sandbox="allow-scripts"` and nothing else, the artefact in a nested frame, heights the only thing the app takes from it                                                                                                                                                                                                                                                                         | G1               |
| Artefacts hardening and activation: the sandbox **on** in every shipped launcher (compose, `npm run dev`, the browser suite, kind; `start.sh` off and saying why) and **scripts on by default** with a per-view _Disable scripts_ and an always-visible note of what a script can still do (`HTML_SCRIPTS_DEFAULT=off` the kill switch, proved in a real browser with no UDP leaving); a `ready` handshake; `appOrigin` in `/config.js`, so a page opened at the wrong address shows source naming both origins; one startup line on the sandbox's state; refusals for a bad `SANDBOX_PORT` or `HTML_SCRIPTS_DEFAULT`, `ALLOW_FRAMING` turning the sandbox off; a geometry cited by `structure_id`; `tool_failed.call_id` dropping exactly the failed draft; artefacts shown read-only where they are turned off; a linked report's **Open report**; the html export saved as `.html.txt`; and example OpenShift manifests held to `server/config.ts` | C4, G1           |

One thing fell out of the work rather than being planned, and is worth recording because it was
invisible until a realistic payload went through it: the trace panel's `<pre>` blocks and the new
tables scroll horizontally, and a scrollable region nothing inside it can focus is unreachable by
keyboard — the content past the right edge does not exist for anyone not using a pointer. It went
unnoticed for as long as the test fixtures were short enough not to overflow. `axe` caught it the
first time a real 200-character tool result did.

---

## Blocked on Chemclaw3

Filed here rather than in `ISSUES.md` because each is a capability request, not a defect:

1. **A stable conversation id** (H3). See `ISSUES.md` #4.
2. **An HTTP surface for subscriptions** (H4). `watch_for` / `list_watches` / `stop_watching` are
   agent tools only; a standing query the chemist cannot see or cancel is a standing query they
   will not create.
