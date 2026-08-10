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

| #      | Persona and story                                                 | Aim                                                                                | Backend                                                                       | Verdict           |
| ------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------- |
| **C1** | Chemist: submit a DFT or conformer job and get on with the day    | Know it landed, be told when it finishes — **and be told when it fails**           | `job_started` / `job_completed` / `job_failed` on `GET /sessions/{id}/events` | **`SERVED`**      |
| **C2** | Chemist: _"what is running, and can I stop it?"_                  | Kill a mis-launched HPC job before it burns a queue slot                           | `GET /jobs`, `GET /jobs/{id}`, `DELETE /jobs/{id}` (reviewer role)            | **`SERVED`**      |
| **C3** | Chemist: _"what did we run three months ago, and why?"_           | Reuse a result instead of re-running it — `job_records` keeps the launch rationale | `find_past_jobs`, `GET /jobs?text=&connector=`                                | **`SERVED`**      |
| **C4** | Computational chemist: download the optimized geometry or Hessian | Take it into another package                                                       | `list_artifacts` / `fetch_artifact` — text only, refuses binaries             | `BLOCKED-BACKEND` |

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

**C4** needs a byte route on the service. An agent tool that returns truncated text cannot hand a
browser a file.

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

| #      | Persona and story                                                     | Aim                                                                               | Backend                                                                                                                                                                    | Verdict      |
| ------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **F1** | Chemist: answer a durable hold                                        | An attributable, irreversible sign-off                                            | `POST /approvals/{id}/decision`                                                                                                                                            | **`SERVED`** |
| **F2** | Chemist: approve the harness plan before it spends                    | Control what the agent is allowed to execute                                      | `GET /sessions/{id}/plan` + a decision bound to `plan_hash`                                                                                                                | **`SERVED`** |
| **F3** | Chemist: find every hold waiting on me                                | Nothing stays blocked because someone closed a tab                                | `GET /approvals` → `PendingApproval[]`                                                                                                                                     | **`SERVED`** |
| **F4** | Reviewer: review machine-written knowledge before it enters the graph | See the exact bytes that would land in the tree; approve, or reject with a reason | `GET /proposals` (keyset paginated, state-filtered), `GET /proposals/{id}` (`content` + `dependencies` + `session_id` + `correlation_id`), `POST /proposals/{id}/decision` | **`SERVED`** |
| **F5** | Non-reviewer: do not offer me buttons that 403                        | Not learn my permissions from an error message                                    | The `roles` claim; `entra_privileged_role_set`                                                                                                                             | **`SERVED`** |

**F1 and F2 are what this frontend is for.** The plan decision is bound to the hash of the plan
that was actually rendered, fetched on card mount so the two cannot drift; a 409 re-reads the plan
and returns to idle rather than blind-retrying with a new hash; both decisions go through a
confirmation that says the decision is irreversible and attributable; and against a service that
predates the plan route the card falls back to answering in the conversation _and says that is what
it is doing_. Nothing in this document asks for these to change.

**F3.** ~~`api.listApprovals` exists and has no callers.~~ **Built**, on `/review`. `ISSUES.md`
Issue 3 said the endpoint did not exist and that an inbox "would be built against nothing"; all
three approval routes do exist, and both stale issues are corrected. The inbox deliberately does
not decide a hold in place — a hold belongs to a turn, and answering it away from the reasoning
that produced the question is answering half a question. It links back instead.

**F4 was the largest untouched capability in the system.** **Built.** The queue lists what is
waiting; opening one shows the literal file content and every file that would land beside it, as
the file it is rather than as rendered markdown — the front matter, the wikilinks and the
confidence field are exactly what a reviewer is checking, and rendering would hide all three. The
Reject control stays disabled until a reason is written, because the service 422s a blank one and
because a note refused without a stated reason tells the next reviewer, and the agent, nothing.

**F5.** ~~`AuthAccount.roles` is parsed from the token and used nowhere.~~ **Built**, as
`useIsReviewer`. The role names cannot be hardcoded — they are a deployment's own — so they come
through `/config.js` as `REVIEWER_ROLES`, alongside the API scope. Controls are hidden rather than
disabled, and the screen says a reviewer role is needed, so nobody forms a judgement they then
cannot record. It is not enforcement and says so: the service decides, and will 403 regardless.

---

## G — Reports and corrections

| #      | Persona and story                                                 | Aim                                                                                                                   | Backend                                                                                                                                                                | Verdict      |
| ------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **G1** | Chemist: assemble a submission section from what we actually have | A draft where each paragraph is wikilinked to its source, and an unsupported section is _marked_ rather than invented | `request_development_report` — durable, per-section memory layer (`evidence` / `episodic` / `semantic`), renders only retrieved chunks, opens a PR-gated `report` note | `PROSE-ONLY` |
| **G2** | Chemist: correct the assistant when it is wrong                   | The correction survives, and contradicts the note that did not hold                                                   | `record_failure` (a `failure-mode` note with a `contradicts` edge), `record_confirmed_answer`                                                                          | `NO-UI`      |

**G1** is one of the service's best-served workflows — the report harness is purpose-built for
regulatory input, and keeping a _failed_ section visibly distinct from an _empty_ one is a real
piece of engineering. It arrives here as a `job_completed` event carrying a summary dict, and there
is no report viewer.

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
handle.

**H5 is left unbuilt on purpose**, and the reason is worth stating rather than leaving as a gap.
`server/routes.ts` excludes `/metrics`, `/schedules` and `/events/knowledge-merged` as operator
surfaces a chemist-facing BFF has no business proxying, and a test pins that exclusion. The story
is real — a silently failing ELN sync surfaces weeks later as "the agent doesn't know about recent
experiments" — but its audience is an operator with Prometheus and the service's logs, not a
chemist in this app. Reversing a documented boundary wants a better argument than one story.

**H4** exists only as agent tools. There is no HTTP route, so a watch can be created by asking and
then never listed or cancelled from the browser.

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

| Shipped                                                                                                                                                                                                                                                                                                       | Stories it moved |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `job_failed` added to `EVENT_TYPES` — the event existed on the wire and was dropped in `normalizeEvent` — with a `JobFailureCard` in both places a job can end, and a launch row that retracts its "runs asynchronously" badge on either ending                                                               | C1               |
| `error.code` / `retryable` / `correlation_id` read, so a budget exhausted as an event locks the composer as the 429 does, a retryable failure is offered a Retry, and the reference is in the banner                                                                                                          | A4               |
| `TranscriptMessage.tool_calls` declared and rebuilt into the trace; the phantom `created_at` removed                                                                                                                                                                                                          | H2               |
| `answer.verified_by` surfaced beside the confidence, because a judge's 0.82 is not a citation gate's 0.82                                                                                                                                                                                                     | A1 (partly)      |
| `GET /sessions/{id}/tool-results/{ref}` whitelisted; a "See the full result" control on any stored result; typed renderers for the hazard screen, the ICH lookup and the charge table, a generic table for anything record-shaped, raw text otherwise — with the `verdict` always above the data it qualifies | A3, D1, D2       |
| `GET /notes/{id}` whitelisted; a citation chip resolves to the note with its provenance, its validity window and its neighbours, and falls back to asking the agent when the reference is not a readable note                                                                                                 | A2               |
| `GET/POST /proposals[...]` whitelisted; a `/review` screen showing the exact bytes a proposal would commit, its dependency files and its correlation id, with a rejection that cannot go out without a reason                                                                                                 | F4               |
| `GET /approvals` given the inbox it always had a client method for, on the same screen                                                                                                                                                                                                                        | F3               |
| `GET/DELETE /jobs[...]` whitelisted; a `/jobs` registry that leads with the recorded rationale rather than the id, searchable over it, with a cancellation that is requested rather than claimed                                                                                                              | C2, C3           |
| The `roles` claim finally used, through `useIsReviewer` and a `REVIEWER_ROLES` runtime setting, to hide what would 403 instead of offering it                                                                                                                                                                 | F5               |
| `GET /profiles` whitelisted and a picker on a not-yet-started conversation, re-applied on every later mint so a recovered session does not silently change agent                                                                                                                                              | H1               |
| `Molecule` draws a reaction as its components with the agents over the arrow, so a `similar_reactions` hit is legible                                                                                                                                                                                         | B4 (partly)      |
| CSV download on any result the panel could table, quoted per RFC 4180                                                                                                                                                                                                                                         | E4 (partly)      |

One thing fell out of the work rather than being planned, and is worth recording because it was
invisible until a realistic payload went through it: the trace panel's `<pre>` blocks and the new
tables scroll horizontally, and a scrollable region nothing inside it can focus is unreachable by
keyboard — the content past the right edge does not exist for anyone not using a pointer. It went
unnoticed for as long as the test fixtures were short enough not to overflow. `axe` caught it the
first time a real 200-character tool result did.

---

## Blocked on Chemclaw3

Filed here rather than in `ISSUES.md` because each is a capability request, not a defect:

1. **An artifact byte route** (C4). `fetch_artifact` returns truncated text and refuses binaries by
   design. A browser download needs `GET /artifacts/{ref}` streaming bytes with a content type.
2. **A stable conversation id** (H3). See `ISSUES.md` #4.
3. **An HTTP surface for subscriptions** (H4). `watch_for` / `list_watches` / `stop_watching` are
   agent tools only; a standing query the chemist cannot see or cancel is a standing query they
   will not create.
