# Making the frontend chemistry-aware

A concept study. It works in three moves: what the backend actually offers, the user stories that
follow from it, and five frontend concepts that could serve them — with what each costs, what each
cannot do, and a staged path through them.

Backend facts are cited against `8fqycwdt8v-oss/Chemclaw3` @ `261b166`; frontend facts against this
repo @ `b2fd195`.

> **Status — read this first.**
>
> This document is the study that preceded the work, written against `b2fd195`, and the body below
> is **kept as written**. Its analysis of what was broken is the argument for what was built, and
> rewriting it in the past tense would leave every decision looking unmotivated — a reader would
> have no way to tell a gap that was closed _because of_ this study from one that was never real.
>
> So every claim below still describes `b2fd195`. Where the claim is no longer true of the code, a
> **`Since:`** line says what closed it and where. There are a lot of them, and the pattern is the
> point: most were closed independently, by work that had never read this document.
>
> **What happened after it was written.** Two efforts ran in parallel without knowing about each
> other. One (PR #12) built Concepts A, B and E and part of D on top of `b2fd195`. The other (PRs
> #13 and #14) rebuilt the UI on a primitives layer and, on the way, independently closed the §2
> contract repair, shipped the whole of Concept D, and — once the backend delivered §8 item 1 —
> shipped Concept C as well. They collided in 34 files. PR #12 was abandoned rather than merged,
> and the half of it that had no counterpart was re-landed on top of the other: the recogniser
> suite, RDKit in the browser, the entity rail, the provenance overlay, and the structure input.
>
> The one thing worth taking from that collision, because this document did not predict it: §6 says
> the concepts "are not alternatives" and can proceed in parallel. They can — but B and E rewrite
> the same components C and D do, and "different files, different routes" turned out to be true of
> the data layer and false of the component tree.

---

## 0. The thesis

The UI today is a chemistry-shaped **chat**. It renders exactly one structure — the
`molecule_smiles` a finished QM job happens to put in its summary dict — plus an opt-in toggle on
inline SMILES the answer text happens to contain. Everything else chemical reaches the chemist as
_sentences the model wrote about it_: a hazard screen with severities and literature citations
arrives as prose, a pKa with its uncertainty arrives as prose, a solvent ranking arrives as prose, a
similarity search that returned nine structures arrives as a list of note ids.

That is not a rendering deficiency, it is a **modelling** one. The frontend has no concept of a
molecule, a reaction, a calculation, a hazard flag or a campaign. It has messages and a trace of
tool names.

So "chemistry-aware" means two things, and they are separable:

1. **Object awareness** — the UI knows the domain's nouns (molecule, reaction, calculation, durable
   job, campaign, hazard flag, knowledge note), gives them identity across a conversation, and can
   show, compare and act on them.
2. **Provenance awareness** — the UI knows that a chemical number is not just a number: it has a
   method (GFN2-xTB vs DFT), a solvent model, an uncertainty, a calibration history, and a validity
   claim ("ranking, not absolute"). This backend is unusual in _having_ all of that; the frontend
   currently discards all of it.

Concepts A–E below attack these in different orders and at different prices.

---

## 1. What the backend actually offers

### 1.1 The capability surface

Seven connector bundles (`src/chemclaw/connectors/*/connector.yaml`), 37 declared tools and durable
jobs, plus ~12 in-process agent tools. The frontend's `KNOWN_TOOLS` list (`shared/events.ts:183`)
names 15, two of which no longer exist.

> **Since:** `KNOWN_TOOLS` now names ~56, grouped by the bundle that serves them, and the two dead
> names are gone. It is used only to pick an icon and a label, so its going stale is cosmetic —
> which is exactly why it went stale.

| Bundle                  | Inline tools                                                                                                                                                                                                                                                                                                                                      | Durable jobs                                                                                                        | What a UI could show                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chem` (RDKit, pure)    | `resolve_compound`, `stoichiometry_table`, `green_metrics`, `render_structure`                                                                                                                                                                                                                                                                    | —                                                                                                                   | A **charge table** (`ChargeRow`: role, equivalents, MW, mmol, mass, density, volume), **E-factor/PMI** metrics, a server-rendered SVG structure                                             |
| `calc` (xTB, cached)    | `compute_xtb_energy`, `compute_electronic_properties`, `predict_site_reactivity`, `optimize_geometry`, `compute_thermochemistry`, `predict_pka`, `predict_solubility`, `predict_logd`, `predict_developability_profile`, `calculator_trust`, `calculator_outliers`, `find_calculations`, `list_artifacts`, `fetch_artifact`, `report_measurement` | `compute_reaction_energy`, `compare_solvents`, `scan_coordinate`, `sample_conformers`, `compute_interaction_energy` | Property values **with uncertainty**, Fukui site maps, ΔE/ΔH/ΔG for a balanced reaction, a **ranked solvent screen**, a **scan profile curve**, a conformer ensemble, calibration residuals |
| `qm` (DFT on HPC)       | —                                                                                                                                                                                                                                                                                                                                                 | `compute_dft_energy`                                                                                                | Long-running job state, `QMJobResult` (`molecule_smiles`, `total_energy_hartree`, converged)                                                                                                |
| `bo` (BoFire)           | `suggest_next_experiment`, `resume_campaign`, `generate_screening_design`, `campaign_progress`, `predict_outcome`                                                                                                                                                                                                                                 | `start_optimization_campaign`                                                                                       | **Candidate conditions**, objective scales, a **Pareto front**, surrogate fit quality, a screening design table                                                                             |
| `safety` (cited tables) | `screen_hazards`, `screen_genotoxic_alerts`, `ich_impurity_limit`                                                                                                                                                                                                                                                                                 | —                                                                                                                   | **Severity-ranked hazard flags** each with `rule_id`, `explanation`, `citation`, `matched` SMARTS; genotox alerts; ICH Q3C/Q3D limits with class and PDE                                    |
| `molfp`                 | `similar_molecules`, `substructure_matches`                                                                                                                                                                                                                                                                                                       | —                                                                                                                   | **Hit lists with structures** and Tanimoto scores, substructure highlighting                                                                                                                |
| `rxnfp`                 | `similar_reactions`                                                                                                                                                                                                                                                                                                                               | —                                                                                                                   | Precedent reactions with DRFP similarity                                                                                                                                                    |
| core (in-process)       | `find_notes`, `expand_note`, `find_knowledge_gaps`, `propose_knowledge_note`, `record_failure`, `gather_evidence`, `record_confirmed_answer`, `recall_observations`, `get_durable_job_status`, `find_past_jobs`, `request_development_report`, `ask_clarifying_question`                                                                          | —                                                                                                                   | Knowledge-graph neighbourhoods, evidence chunks, note proposals                                                                                                                             |

Two properties of this surface matter for design:

- **The results are typed on the backend and untyped on the wire.** `HazardFlag`, `ChargeRow`,
  `ImpurityLimit`, `ExperimentSuggestion`, `MoleculeHit`, `Calibration`, `XtbJobResult` are all
  Pydantic models. None of that structure survives the trip to the browser (§3, C1).
- **Everything expensive is already cached and idempotent.** `find_calculations` answers "has this
  already been run", `job_workflow_id` deliberately excludes the requester so identical requests
  rejoin one run. A UI can therefore afford to be _exploratory_ — offering "compute this" buttons is
  not the same risk it would be against an uncached backend.

### 1.2 The knowledge graph

`knowledge/` holds Markdown notes with typed frontmatter, one directory per type:
`compound`, `reaction`, `campaign`, `optimization-campaign`, `playbook`, `interaction`, `report`,
`experiment-proposal`, `failure-mode`, plus bundle-declared `job-result` and `bo-candidate`.

Compound notes carry `compound_smiles` in frontmatter; reaction notes carry conditions in the body
and `[[wikilink]]` relations (`knowledge/compound/compound-4-bromoanisole.md`). Notes also carry
`calc_refs` and `artifact_refs` — the join between "what we know" and "what we computed".

**Every note the agent writes goes through a PR-gate.** `propose_knowledge_note` opens a branch; a
human approves. The backend exposes this at `GET /proposals`, `GET /proposals/{id}` (with the full
note content and its dependencies) and `POST /proposals/{id}/decision`.

### 1.3 The HTTP surface (and what the BFF forwards)

| Backend route                                                                          | In BFF whitelist (`server/routes.ts`)? |
| -------------------------------------------------------------------------------------- | -------------------------------------- |
| `POST /sessions`, `GET /sessions`, `GET /sessions/{id}/messages`                       | yes                                    |
| `POST /sessions/{id}/messages` (SSE turn), `GET /sessions/{id}/events` (SSE push-back) | yes                                    |
| `POST /sessions/{id}/attachments`                                                      | yes                                    |
| `GET /sessions/{id}/plan`, `POST /sessions/{id}/plan/decision`                         | yes                                    |
| `GET /approvals`, `GET /approvals/{id}`, `POST /approvals/{id}/decision`               | yes                                    |
| `GET /jobs`, `GET /jobs/{id}`, `DELETE /jobs/{id}`                                     | no                                     |
| `GET /proposals`, `GET /proposals/{id}`, `POST /proposals/{id}/decision`               | no                                     |
| `GET /profiles`                                                                        | no                                     |

> **Since:** all three are whitelisted, and two routes that did not exist when this was written have
> joined them — `GET /sessions/{id}/tool-results/{ref}` (the §8 item 1 ask, delivered) and
> `GET /notes/{id}` (the §8 item 3 ask, delivered). `scripts/check-openapi.mjs` now diffs the
> whitelist against the service's own OpenAPI schema on demand, so the _next_ row of this table
> gets found by a command rather than by reading two checkouts side by side.

The three rows that read "no" are not missing features — they are implemented, tested backend routes
(`src/chemclaw/api/routes/jobs.py`, `proposals.py`, `sessions.py:171`) that this UI simply cannot
reach. Whitelisting them is the whole of the workbench's data layer. `ISSUES.md` records
`/approvals` and `/sessions` as backend gaps; both have already been implemented upstream, and that
file needs correcting.

> **Since:** `ISSUES.md` is corrected.

One correction to the reading above, found on contact with the code: **`GET /jobs` lists finished
runs only.** It reads `job_records`, and a row is written when a run _completes_ — so the listing
answers "what has this system finished", not "what is running now". A running job is reachable only
by its id. That is why the jobs view has an open-by-id box beside the list rather than a cancel
button on every row, which would have been decorative.

Two more capabilities the UI does not use:

- **`MessageIn.dry_run`** (`src/chemclaw/api/schemas.py:26`) — "plan the turn without launching
  anything expensive". A natural primitive for a _Estimate first_ affordance.
- **`SessionIn.profile`** — start a session as a narrowed agent. `data/profiles/property-lookup.yaml`
  is exactly a "chemistry calculator mode": five tools, terse answers, no research loop.

### 1.4 The event contract

The backend union (`src/chemclaw/api/events.py`) has **15** members. `shared/events.ts` mirrors 14,
and three of the mirrored ones have since grown fields.

> **Since:** every row below is closed and each field has a consumer — `job_failed` and
> `verified_by` in the transcript, `error.code` in the banner's next-step text, `note_ids` in the
> entity index, `numbers` in the grounding overlay. They are kept because the pattern they form is
> the argument for the drift check now in `scripts/check-openapi.mjs`.

| Backend                                                  | Frontend mirror | Consequence                                                                                                                                                                                                                                         |
| -------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job_failed` (`job_id`, `reason`)                        | **absent**      | `normalizeEvent` drops it and `useJobFeed` only handles `job_completed` — a durable job that fails after its turn ends shows "runs asynchronously" forever. The backend added this event _precisely_ so that would stop happening.                  |
| `tool_result.note_ids: string[]`                         | **absent**      | The untruncated list of note ids a call returned.                                                                                                                                                                                                   |
| `tool_result.numbers: float[]`                           | **absent**      | The untruncated, deduplicated list of **numeric values** a call returned — 5 for an ICH lookup, 27 for a charge table, 49 for a full electronic-properties run. This is real structured chemistry data already on the wire and currently discarded. |
| `answer.verified_by: "judge" \| "citation-gate" \| null` | **absent**      | Whether the confidence score came from the LLM judge or the weaker fallback. Without it, "low confidence" and "the check that earns confidence never ran" render identically.                                                                       |
| `error.code` / `retryable` / `correlation_id`            | **absent**      | A closed 8-member taxonomy (`turn_timeout`, `budget_exhausted`, `loop_cap_reached`, `empty_answer`, …) that would let the UI offer the right next step instead of "try again".                                                                      |

Also unused: `TranscriptMessage.tool_calls` (`src/chemclaw/api/schemas.py:71`) carries `tool`,
`arguments` **and `result`** per call, truncated to 400 chars. The UI's `TranscriptMessage` declares
only `role`/`text`/`created_at`, so reloading a conversation loses its whole trace.

> **Since:** read on rehydrate (`src/App.tsx`), including the third state the backend is careful to
> distinguish: a stored call whose `result` is `null` ran and its outcome was not recorded, which is
> neither a success nor a failure and must not render as "running".

---

## 2. Where the frontend stands

Renders today:

- `job_completed.summary.molecule_smiles` → 2D structure via `smiles-drawer` (`src/components/Molecule.tsx`).
- `total_energy_hartree` and a converged/not-converged pill (`src/components/JobResultCard.tsx`).
- Inline `` `code` `` spans that pass `looksLikeSmiles()` → opt-in render toggle (`src/lib/citations.ts:98`).
- Citation-shaped tokens (`reaction-*`, `note-*`, `qm-*`) → chips (`src/lib/citations.ts:29`).
- Tool calls and their 200-char result previews as raw `<pre>` (`src/components/TracePanel.tsx`).
- Verifier signals: `review_required` pill, confidence, unsupported claims.

That is the entire chemistry surface. Concretely: a turn that screens six molecules for hazards,
computes three pKa values with uncertainties, and ranks four solvents produces **zero** chemistry UI.

> **Since:** that same turn now produces a hazard card with severities and citations, a value card
> per property, a ranked solvent table with a CSV export, an entity rail listing the six molecules
> under canonical keys, a method badge and manifest caveat per call, and figure marks on the answer
> checked against `tool_result.numbers`. The `looksLikeSmiles` in the bullet above also rejected
> `CCO` — it demanded a bracket, a digit or a bond character — so straight-chain molecules were
> never offered a render at all; `src/chem/recognise.ts` replaces it.

### Verified drift worth fixing regardless of which concept is chosen

> **Since:** all eight are closed. Items 1–4 and 7 landed in the contract repair; items 5 and 6 in
> the UI rebuild; item 8 was a documentation fix. Nothing in this list needed a backend change,
> which was the argument for doing it first.

1. `job_failed` is dropped on the floor (§1.4).
2. `tool_result.numbers` / `note_ids` are dropped.
3. `answer.verified_by` is dropped.
4. `error.code` / `retryable` / `correlation_id` are dropped.
5. `KNOWN_TOOLS` (`shared/events.ts:183`) and `TOOL_ICON` (`src/components/TracePanel.tsx:23`) list
   `submit_qm_job` and `get_qm_job_status`, which no longer exist (the real names are
   `compute_dft_energy` and `get_durable_job_status`), and omit ~35 tools that do.
6. `/jobs`, `/proposals`, `/profiles` are not in the BFF whitelist.
7. Transcript rehydration discards `tool_calls`.
8. `ISSUES.md` issues 2 and 3 are resolved upstream.

---

## 3. Constraints every concept must respect

**C1 — Tool results are 200-char raw previews.** `ToolResultEvent.preview` is truncated by
`agent_audit_max_arg_chars`, may cut mid-token, and is explicitly _not_ JSON. The backend's own
docstring says why it will stay that way: "never a whole evidence sweep streamed to a browser". Any
concept that wants a hazard table or a solvent ranking must either (a) get the data another way,
(b) reconstruct from `numbers`/`note_ids`, or (c) ask for a backend change. **Parsing the preview is
not an option** and the codebase already says so in three places.

**C2 — `JobSummary` is an untyped dict.** `job_completed.summary` is `dict[str, object]`. The
existing `JobResultCard` probes every field. Any richer job card must keep probing, and must render
_something_ for a job kind it has never seen.

**C3 — There are no chemistry types on the wire.** No SMILES field, no structure list, no unit, no
method — except inside the one job summary. Every other structure the UI shows must be _recovered_
from text (tool arguments, answer prose) with the attendant false-positive risk that
`looksLikeSmiles()` was written conservatively to avoid.

**C4 — The BFF is a whitelist, not a proxy.** New data means a new route entry, deliberately
(`server/routes.ts:1`). The browser never talks to the service. This is cheap but it is not free,
and it is the right place to say "this UI has no business reaching `/metrics`".

**C5 — Bundle budget.** `Molecule.tsx` documents the trade: `smiles-drawer` is pure JS and
lazy-loaded; `@rdkit/rdkit` is multi-megabyte WASM. Substructure highlighting, canonicalisation and
reaction drawing are the things that would justify RDKit — and `Molecule.tsx` says it is the only
file that changes if that day comes.

> **Since:** that day came, and the list was half right. **Canonicalisation** justified it — the
> entity rail cannot key on anything else. **Validation** justified it, which this study did not
> anticipate: a recogniser loose enough to accept `CCO` is only safe if something can refuse a
> string before it is drawn. **Molblock parsing** justified it, for the structure input's file drop.
> **Substructure highlighting did not**, and the reason is worth recording: `HazardFlag.matched` is
> the input a rule fired _on_, not the SMARTS it fired _with_, and the pattern never crosses the
> wire — so the highlight has no source and was not built. Reaction drawing did not either; RDKit's
> minimal build ships no reaction object, so the split stayed in the component.
>
> The bundle cost came out where the trade assumed: the entry chunk was unchanged across the swap
> (485.86 kB → 485.78 kB) because the WASM sits behind a dynamic import in its own chunk, and
> `index.html` preloads none of it. `Molecule.tsx` was also right that it would be the only file to
> change — it and one new module.

**C6 — The honesty rule.** `TracePanel.tsx:4` and `README.md:22` both record a discipline: the panel
must never imply it is showing something it is not. A chemistry-aware UI raises the stakes on this —
a structure drawn from a mis-detected token, or a value shown without its method, is worse than no
structure and no value.

---

## 4. User stories

Derived from backend capability, grouped by who asks. Each names the backend basis and what the
frontend would need. "Reachable today" means: no backend change.

> **Since:** the tables are left exactly as assessed, because the "reachable today" column is the
> argument for the staging in §7 and it was mostly right. What has actually been served, so a
> reader does not have to diff twenty-six rows by hand:
>
> - **Served:** US-1, US-2, US-3, US-4, US-5, US-6, US-7, US-8, US-9, US-10, US-14, US-15 (in part),
>   US-16, US-17, US-18, US-19, US-20, US-21, US-22, US-23, US-24, US-26.
> - **Not served, and each for a reason on the record:** US-11 (no chart layer; the scan result
>   renders as a table), US-12 (still needs the artifact route), US-13 (needs a search surface over
>   `find_calculations`, which is an agent tool), US-25 (the campaign view; a Pareto plot is the same
>   missing chart layer as US-11).
> - **Served differently than assessed:** US-15 is a severity-ordered flag list with citations, but
>   _without_ the motif drawn on the structure. The assessment assumed `HazardFlag.matched` carried
>   the SMARTS; it carries the input the rule fired on. See C5.
> - **Wrongly assessed:** US-3 and US-4 are marked "needs backend" on the reasoning that a charge
>   table cannot survive C1. That was right about the preview and wrong about the conclusion — the
>   answer was a _reference_ to the full result, not a bigger event, and that is §8 item 1.

### P1 — Bench / process chemist

| #    | Story                                                                                                                                        | Backend basis                                                                                                                                       | Frontend needs                                                                                                     | Reachable today                                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| US-1 | _As a process chemist, I want every molecule the agent mentions drawn, so I can check it is the compound I meant before I trust the answer._ | SMILES appear in `tool_call.arguments`, in answer prose, in `job_completed.summary`, in `compound` note frontmatter                                 | SMILES extraction from all four sources; structure rendering; a "this is what I understood you to mean" affordance | yes (partly)                                                     |
| US-2 | _…I want a reaction I describe drawn as a reaction, not as two unrelated structures._                                                        | `similar_reactions` takes reaction SMILES; `compute_reaction_energy` takes balanced species lists                                                   | Reaction SMILES parsing (`A.B>>C`), arrow layout                                                                   | yes                                                              |
| US-3 | _…I want the charge table as a table I can read off at the bench — roles, equivalents, mmol, mass, volume — not as a paragraph._             | `stoichiometry_table` → `ChargeTable`/`ChargeRow`                                                                                                   | Structured tool result (C1) **or** reconstruction from `numbers`                                                   | needs backend                                                    |
| US-4 | _…I want to see which reagents did not resolve, because a silently-dropped reagent is a wrong table._                                        | `ChargeTable.unresolved: list[str]`                                                                                                                 | same as US-3                                                                                                       | needs backend                                                    |
| US-5 | _…I want to paste or draw a structure into the composer instead of typing SMILES._                                                           | every tool takes SMILES                                                                                                                             | A structure input (paste-SMILES, file drop, optional sketcher)                                                     | yes                                                              |
| US-6 | _…I want to ask "what would this cost" before authorising an expensive run._                                                                 | `MessageIn.dry_run`, `expensive: true` on `sample_conformers` / `compute_interaction_energy` / `compute_dft_energy` / `start_optimization_campaign` | A dry-run toggle in the composer; a cost/plan preview                                                              | yes (BFF already forwards the route; needs the flag in the body) |
| US-7 | _…I want a compact "calculator mode" for the dozens of property lookups I do a day._                                                         | `SessionIn.profile` + `data/profiles/property-lookup.yaml`                                                                                          | `GET /profiles` in the whitelist; profile picker on session creation                                               | BFF only                                                         |

### P2 — Computational chemist

| #     | Story                                                                                                                                             | Backend basis                                                                                                                                                                                 | Frontend needs                                                                   | Reachable today                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------ |
| US-8  | _…I want a computed value shown with its method, solvent model and uncertainty, because a bare number invites a use the method does not support._ | `XtbResult`, `PkaResult`, `SolubilityResult` carry uncertainty; job descriptions carry the caveats verbatim ("semiempirical … for comparing related reactions, not for a number in a report") | Method/uncertainty badges; a caveat surface keyed on tool name                   | partly (`numbers` gives values, not units) |
| US-9  | _…I want to know how far to trust this calculator before I authorise work that depends on it._                                                    | `calculator_trust` → `Calibration`, `calculator_outliers` → residuals with `within_uncertainty`                                                                                               | A calibration panel; residual plot                                               | needs backend                              |
| US-10 | _…I want a solvent screen shown as a ranking, because the differences are trustworthy and the absolutes are not._                                 | `compare_solvents` → `SolventComparisonResult`                                                                                                                                                | Ranked bar/table with ΔΔG framing                                                | needs backend                              |
| US-11 | _…I want a coordinate scan shown as a curve with the barrier marked._                                                                             | `scan_coordinate` → `ScanResult`                                                                                                                                                              | Line chart; explicit "upper bound on the ground-state profile, not a TS" caption | needs backend                              |
| US-12 | _…I want to reach a finished calculation's artifacts (geometry, vibspectrum) without asking the agent to paste them._                             | `list_artifacts` / `fetch_artifact` by `calc_ref`                                                                                                                                             | Artifact list + viewer/download                                                  | needs backend or BFF passthrough           |
| US-13 | _…I want to know whether this has already been computed before I start it._                                                                       | `find_calculations` (explicitly "the lookup a chemist makes before authorising an expensive run")                                                                                             | A search surface over calculations                                               | needs backend                              |
| US-14 | _…I want a long DFT job to tell me when it fails, not just when it succeeds._                                                                     | `JobFailedEvent` on `GET /sessions/{id}/events`                                                                                                                                               | Mirror `job_failed`; a failed-job card                                           | **yes — pure frontend bug**                |

### P3 — Safety / regulatory reviewer

| #     | Story                                                                                                                                            | Backend basis                                                                          | Frontend needs                                                                                                   | Reachable today |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------- |
| US-15 | _…I want hazard flags ranked by severity, each with the motif it matched and its citation, because "advisory" means I must be able to check it._ | `screen_hazards` → `HazardFlag{rule_id, severity, explanation, citation, matched}`     | Severity-ordered flag cards; SMARTS → substructure highlight (C5)                                                | needs backend   |
| US-16 | _…I want a genotoxic alert to be visually distinct from a general hazard, because they are different questions._                                 | `screen_genotoxic_alerts` → `GenotoxAlert` — a separately governed table               | Distinct card type                                                                                               | needs backend   |
| US-17 | _…I want an ICH limit shown with its class, its meaning and its unit basis, not as a bare ppm number._                                           | `ich_impurity_limit` → `ImpurityLimit{limit_class, class_meaning, limits[], citation}` | A limit card; `LimitValue` basis/unit rendering                                                                  | needs backend   |
| US-18 | _…I want to see plainly when the safety connector was down for a turn, because "no flags" and "not screened" are different answers._             | `capability_degraded`                                                                  | Already stored on the message — but rendered as a generic notice, not as "this answer contains no hazard screen" | yes (sharpen)   |

### P4 — Knowledge steward / approver

| #     | Story                                                                                                                                                        | Backend basis                                                                                                                                  | Frontend needs                                                               | Reachable today |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------- |
| US-19 | _…I want to review the notes the agent proposed — the full note, its dependencies, its session — and approve or reject them here rather than in a git host._ | `GET /proposals`, `GET /proposals/{id}` → `ProposalDetail{content, dependencies, session_id, correlation_id}`, `POST /proposals/{id}/decision` | Review queue + diff/preview + decision buttons                               | BFF only        |
| US-20 | _…I want a proposed `compound` note to show its structure and a `reaction` note its transformation while I review it._                                       | `compound_smiles` frontmatter; `[[wikilink]]` relations                                                                                        | Frontmatter parsing + structure rendering in the review view                 | BFF only        |
| US-21 | _…I want to follow a citation chip to the actual note, not just see it highlighted._                                                                         | `expand_note` is an agent tool; there is **no** note-read HTTP route                                                                           | Either a backend note route, or resolve via the proposal/transcript surfaces | needs backend   |
| US-22 | _…I want pending approvals visible outside the conversation that raised them._                                                                               | `GET /approvals` (already whitelisted, already in `client.ts`, currently unused by any view)                                                   | An approvals inbox                                                           | **yes**         |

### P5 — Project lead / operator

| #     | Story                                                                                                                          | Backend basis                                                                                               | Frontend needs                                  | Reachable today     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------- |
| US-23 | _…I want to see every durable run — what is going, what it cost, what it produced — without hunting for job ids in old chats._ | `GET /jobs`, `GET /jobs/{id}` → `DurableJobStatus{status, summary, result, rationale}`                      | Jobs view                                       | BFF only            |
| US-24 | _…I want to stop a runaway campaign._                                                                                          | `DELETE /jobs/{id}` (reviewer-gated, 403 otherwise, 202 = cooperative)                                      | Cancel action that handles 403 and 202 honestly | BFF only            |
| US-25 | _…I want a campaign's progress and its recommendation, not a job id._                                                          | `campaign_progress`, `resume_campaign` → `CampaignThread`, `ExperimentSuggestion{candidates, scale, front}` | Campaign view; Pareto/objective plot            | needs backend       |
| US-26 | _…I want to know whether a low-confidence answer was scored by the judge or by the fallback gate._                             | `answer.verified_by`                                                                                        | Mirror the field; distinguish in `AnswerBadges` | **yes — one field** |

---

## 5. Five concepts

Each is a coherent position, not a feature list. They compose, but they are genuinely different bets
about where the value is.

---

### Concept A — _Chemistry-aware prose_

**Premise:** the chemistry is already in the text; teach the renderer to see it.

The answer body, the tool arguments and the citation tokens are treated as a chemistry document
rather than as markdown. Concretely:

- Extend `looksLikeSmiles` to a small **recogniser suite**: molecule SMILES, reaction SMILES
  (`>>`), SMARTS (in hazard context), `calc_ref` (`type@version:hash:hash` — the pattern is already
  regexed backend-side at `kg/note.py:170`), job ids, note ids, ICH substance names.

  > **Since:** built as molecule SMILES, reaction SMILES and compound-name detection, and no
  > further. A `calc_ref` recogniser was written and then deleted: nothing can act on a calc ref,
  > because reaching a calculation's artifacts needs the backend route US-12 still lacks, and a
  > recogniser nobody asks is indistinguishable from one that is wrong. Note ids stayed in
  > `src/lib/citations.ts` rather than moving here — they are an identifier question, not a
  > structure question, and one rule with two spellings drifts.

- Render molecules **inline and small** where they appear, with the existing opt-in discipline
  raised to a per-conversation preference rather than a per-token click.
- Draw reaction SMILES as a reaction (reactants → products), not as N unrelated sketches.
- Lift SMILES out of `tool_call.arguments` too — a `predict_pka` call whose arguments preview reads
  `{"smiles": "COc1ccc(Br)cc1"}` should draw that molecule in the trace row.
- Attach **method caveats by tool name**: a static map from tool → the caveat its own manifest
  states ("ranking, not an absolute binding energy"; "an upper bound on the ground-state profile").
  This text exists, is authored by the people who wrote the method, and currently reaches nobody.

**Needs:** nothing from the backend. Recognisers, a caveat table, reaction layout in `Molecule.tsx`.

**Covers:** US-1, US-2, US-8 (partly), US-18.

**Cost:** small. Days, not weeks. No new dependency (reaction layout can be composed from
`smiles-drawer` per component + a drawn arrow).

**Risk:** false positives. C6 bites hardest here — a mis-detected "SMILES" drawn as a structure is
an active lie. Mitigation: keep the conservative recogniser, prefer _offering_ a render over
performing one, and never draw from a truncated string (a preview cut mid-token can produce a
_valid_ but _wrong_ SMILES — this is the single most dangerous failure mode in this whole document
and any implementation must refuse to draw from `preview`, only from `arguments` when unterminated
and from full-text sources otherwise).

**Cannot do:** anything that needs the values a tool returned. No hazard table, no ranking, no
uncertainty.

---

### Concept B — _The entity rail_ (conversation subject index)

**Premise:** a chemistry conversation is _about_ things; give those things identity and a home.

A persistent side rail accumulates the **entities** of the conversation as first-class objects, from
every place they appear:

```
molecules     ← tool arguments, answer text, job summaries, note frontmatter
reactions     ← reaction SMILES, compute_reaction_energy args, similar_reactions
calculations  ← calc_refs in text, tool_result.numbers attached to their call
jobs          ← job_started / job_completed / job_failed
notes         ← note_proposed, citation chips, tool_result.note_ids
campaigns     ← job kind "campaign", campaign ids in bo tool args
```

Each entity gets a card: structure, every value the conversation ever attached to it, which tool
produced each value, and which turn. Clicking one filters the transcript to the turns that mention
it. Two molecules can be pinned side by side.

This is the concept that most directly answers "chemistry-aware": the UI stops being a log and
starts being a **workspace with a subject**. It is also the one that pays off most as a conversation
gets long — which is exactly when a chat UI otherwise degrades.

**Needs:** a client-side entity store keyed by canonical identity. That last word is the catch:
without RDKit in the browser, `COc1ccc(Br)cc1` and `BrC1=CC=C(OC)C=C1` are different keys. Options:
(a) accept string identity and de-duplicate imperfectly, (b) pull in RDKit WASM (C5), (c) ask the
backend to echo canonical SMILES (it already computes it — `core.chem.require_canonical_smiles`).
Option (c) is one field and is the right ask.

> **Since:** built on (b), and (c) is no longer the right ask. The judgement here weighed only the
> entity key, where one echoed field would indeed have been cheaper. It missed that the same
> toolkit is needed twice more on this side of the wire — to refuse a string the recogniser guessed
> at, and to read a dropped molblock — and neither of those has a backend echo. Given RDKit is
> present for those, asking for the field would buy nothing.
>
> One thing this section got exactly right: the store is keyed **per conversation**. The first
> implementation was one global bag, and switching conversations left the previous one's molecules
> in the rail with `selected` pointing at them, which filtered the new transcript against the old
> conversation's mentions and rendered "nothing about that" over a conversation full of turns.

**Covers:** US-1, US-2, US-5, US-12 (as a place to hang artifacts), US-21 (partly), and it is the
substrate every later concept renders into.

**Cost:** medium. The store and its extraction rules are the work; the cards are cheap.

**Risk:** an entity rail full of noise is worse than none. Needs a strict promotion rule — an entity
appears only when it came from a _structured_ source (a tool argument, a job summary, a note id),
never from loose prose alone.

**Cannot do:** show what a tool returned, beyond `numbers`/`note_ids`.

---

### Concept C — _Typed result cards_ (the instrument panel)

**Premise:** each tool has a natural rendering; build the fifteen that matter.

`screen_hazards` renders as severity-ordered flag cards with the matched motif highlighted on the
structure and the citation quoted. `stoichiometry_table` renders as a bench-ready charge table with
a "unresolved" warning row. `compare_solvents` renders as a ranking with the ΔΔG framing its own
manifest demands. `scan_coordinate` renders as a curve. `similar_molecules` renders as a hit grid of
structures with Tanimoto scores. `calculator_trust` renders as a calibration panel.

This is where nearly all of the chemistry value is — and it is **blocked on C1**. The 200-char
preview cannot carry a `ScreenResult`.

> **Since:** unblocked, by option 2 below, and built. The backend added `tool_result.result_ref`
> plus `GET /sessions/{id}/tool-results/{ref}`; `src/components/ResultSheet.tsx` pulls the one
> result a reader asked for and renders it. The §5 prediction that cards should key on _result
> shape_ rather than on tool name held up — the renderers are a cited-flag list, a ranked
> comparison, a row table and a value card, with a generic table and raw text beneath them.

Three ways through, in ascending order of backend cost:

1. **Reconstruct from `numbers` + `note_ids`.** Already on the wire, already untruncated. Gets you a
   value strip ("this call returned 5 values: 5000, 2, 890, …") but not their labels. Honest, cheap,
   and much weaker than a real card. Useful as a _bridge_, not a destination.
2. **A result reference.** Backend adds `tool_result.result_ref`; the UI fetches the full typed
   result from a new route. This preserves the budget rule that motivated the truncation (the
   browser pulls what it chooses to render, once, rather than every result being streamed to every
   surface) and it is the smallest change that unblocks every card.
3. **Typed payloads on the event.** `tool_result.data: dict` for a whitelist of tools whose results
   are known-small (hazard screen, ICH lookup, charge table, calibration). Simpler than (2), but it
   re-opens exactly the budget question the backend closed deliberately, so it should be scoped to
   bounded results only.

**Covers:** US-3, US-4, US-9, US-10, US-11, US-15, US-16, US-17, US-25.

**Cost:** large, and gated on a backend decision. But it is incremental _after_ the gate: each card
is independent, and the fallback (today's `<pre>`) is always available for an unrecognised tool.

**Risk:** the fifteen-card treadmill. Mitigation: the manifest already classifies tools, so cards
should key on _result shape_, not on tool name — "a list of cited flags", "a ranked comparison", "a
table of rows", "a value with uncertainty" — which is four or five renderers, not fifteen.

---

### Concept D — _The chemistry workbench_ (beyond the chat)

**Premise:** some chemistry questions are not conversations. Stop routing them through one.

Chat becomes one surface among several:

- **Jobs** — every durable run, its state, its result, cancel (`GET /jobs`, `DELETE /jobs/{id}`).
  This is the surface `useJobFeed` gestures at and cannot deliver: a job outlives the conversation
  that started it, and the backend's own docstring says the job surface exists because "a result
  from a session that had since been evicted was unreachable".
- **Review queue** — proposed notes and pending approvals in one inbox (`GET /proposals`,
  `GET /approvals`). This is the GxP spine of the architecture and it currently has no UI at all.
- **Profiles** — start a session as `property-lookup` instead of the general agent (`GET /profiles`).
- **Structure-first entry** — paste a molecule, get actions (screen it, predict its pKa, find
  similar) that compose a chat turn behind the scenes.

**Needs:** BFF whitelist entries (§1.3) and new views. **No new backend capability.**

> **Since:** built — `src/components/JobsPanel.tsx`, `ReviewQueue.tsx` and the composer's profile
> picker. Structure-first entry landed as the composer's structure input rather than as a separate
> surface, which is the same "composes a message, never a tool call" restraint §9 argues for.

**Covers:** US-7, US-19, US-20, US-22, US-23, US-24, and gives US-5 somewhere to live.

**Cost:** medium, and unusually _low-risk_: the data is typed JSON from real routes, so none of C1's
truncation problems apply. This is the best value-per-risk in the document.

**Risk:** scope. A workbench invites an admin console. Keep it to what a chemist and a reviewer
actually do; leave `/metrics` and `/schedules` off the whitelist as the BFF's comment already argues.

---

### Concept E — _The provenance overlay_

**Premise:** in this domain, the qualifier is the content. Render the qualifiers.

Nothing new is drawn; everything shown is _annotated_:

- **Method badges.** GFN2-xTB vs DFT vs a lookup table vs a surrogate model, derived from the tool
  that produced the value. A chemist should never have to ask which one a number came from.
- **Uncertainty as first-class.** Where a result carries one, it is rendered with the value, not
  after it.
- **Grounding highlights.** `tool_result.numbers` is a list of every figure the turn's tools
  actually returned. Highlight figures in the answer that appear in it, and flag figures that do
  not. The backend built this list for exactly this check and documents the live run where its
  absence produced nine false fabrication verdicts.
- **Verifier honesty.** Distinguish `verified_by: "judge"` from `"citation-gate"` from `null`
  (US-26), and render `capability_degraded` as a chemistry statement — "this answer contains no
  hazard screen because the safety connector was unreachable" — not a generic connector name.
- **Calibration.** Where `calculator_trust` has been consulted, show it beside the prediction.

**Needs:** mirroring four fields already on the wire (`numbers`, `note_ids`, `verified_by`, `error.code`);
a tool → method map; and, for calibration, Concept C.

**Covers:** US-8, US-18, US-26, and most of US-9.

**Cost:** small-to-medium. The highest ratio of chemist trust gained per line of code in this
document, because it is almost entirely _already-transmitted data being discarded_.

**Risk:** annotation clutter. Provenance must be legible at a glance and expandable on demand, or it
becomes visual noise that trains people to ignore it — which is worse than absent.

---

## 6. Comparison

|                       | A · prose            | B · entity rail                         | C · result cards                      | D · workbench             | E · provenance             |
| --------------------- | -------------------- | --------------------------------------- | ------------------------------------- | ------------------------- | -------------------------- |
| Backend change needed | none                 | one field (canonical SMILES) — optional | **yes** (result_ref or typed payload) | none                      | none                       |
| BFF change needed     | no                   | no                                      | maybe (result fetch)                  | **yes** (3 routes)        | no                         |
| New dependency        | no                   | RDKit if canonicalising client-side     | no                                    | no                        | no                         |
| Stories covered       | 4                    | 5                                       | 9                                     | 6                         | 4                          |
| Effort                | S                    | M                                       | L                                     | M                         | S–M                        |
| Risk profile          | false positives (C6) | noise                                   | backend dependency + treadmill        | scope creep               | clutter                    |
| Value if built alone  | modest               | high, grows with conversation length    | highest                               | high, independent of chat | high trust, low visibility |
| Blocks anything?      | no                   | is the substrate for C and E cards      | no                                    | no                        | no                         |

**They are not alternatives.** A and E are almost free and should happen regardless. D is
independent of everything and can proceed in parallel. B is the substrate that makes C's cards feel
like a workspace rather than a stream of widgets. C is the destination and the only one with a hard
external dependency.

---

## 7. A staged path

> **Since:** the stages happened, and not in this order, and not by one person. Stage 0 and Stage 2
> landed together in the UI rebuild; Stage 4 landed before Stage 3 because the backend delivered §8
> item 1 sooner than expected; Stages 1 and 3 landed last, on top of the rest. The sequencing
> argument still reads as correct — nothing here should have been built on a stale mirror — but the
> assumption that the stages are separable _by file_ was wrong. See the status note at the top.

**Stage 0 — contract repair (days).** The eight drift items in §2. Independently justified: item 1
is a user-visible bug (a failed job is silently invisible), and items 2–4 are data the browser is
already receiving and throwing away. Nothing below is worth building on a stale mirror.

**Stage 1 — A + E (weeks).** Chemistry-aware prose and the provenance overlay. No backend
dependency, no new dependency, immediately visible to a chemist. Ends with: every molecule drawn,
every value carrying its method, every unsupported figure flagged.

**Stage 2 — D (weeks, parallel).** Whitelist `/jobs`, `/proposals`, `/profiles`; build the jobs view,
the review queue, the profile picker. Independent of Stage 1 — different files, different routes —
so it can run concurrently and by a different person.

**Stage 3 — B (weeks).** The entity rail, keyed on canonical SMILES if the backend echo lands and on
string identity if it does not.

**Stage 4 — C (open-ended, gated).** Typed result cards, once the backend decision in §8 is made.
Build the four _shape_ renderers first (cited-flag list, ranked comparison, row table,
value-with-uncertainty); they cover eleven of the fifteen tools worth carding.

---

## 8. What to ask the backend for

Ordered by value per unit of backend work.

1. **A way to reach a full tool result.** `tool_result.result_ref` + a fetch route is the smallest
   change that unblocks Concept C, and it preserves the streaming budget the truncation exists to
   protect. Alternative: `data: dict` on the event, restricted to results with a bounded size
   (hazard screen, genotox alerts, ICH lookup, charge table, calibration, green metrics).

   > **Since: delivered, exactly as asked.** `tool_result.result_ref` and
   > `GET /sessions/{id}/tool-results/{ref}` both exist and are whitelisted.

2. **Canonical SMILES echo.** Any tool that takes a molecule already canonicalises it
   (`core.chem.require_canonical_smiles`). Echoing it in the result — or in `tool_call` — gives the
   frontend a stable entity key without shipping RDKit to the browser.

   > **Since: withdrawn.** RDKit is in the browser for two other reasons that no echo can serve
   > (validating a recogniser's guess, reading a molblock), so the field would now buy nothing. See
   > Concept B.

3. **A note-read route.** `GET /notes/{id}` (or a proposal-independent read of `expand_note`'s
   `NoteView`) so a citation chip can resolve to the note it cites (US-21). Today the knowledge
   graph is readable by the agent and by nobody else.

   > **Since: delivered.** `GET /notes/{id}` exists, is whitelisted, and a citation chip opens the
   > note it names — falling back to asking the agent when the reference is not a readable note,
   > which a `qm-…` chip often is not.

4. **A typed job summary**, or at least a documented per-kind shape, so `JobResultCard` can stop
   probing (C2).
5. Nothing else. `job_failed`, `numbers`, `note_ids`, `verified_by`, `error.code`, `/jobs`,
   `/proposals`, `/profiles`, `dry_run` and profiles are **already there** — the work on those is
   entirely on this side of the wire.

   > **Since:** all of it done. What remains on the backend is item 4 alone, plus the SMARTS motif
   > that would let a hazard flag be drawn on the structure it fired on (see C5) — an ask this
   > study did not know it needed, because it assumed `HazardFlag.matched` carried the pattern.

---

## 9. Open questions

- **Who is the primary user?** The stories split cleanly by persona, and the concepts rank
  differently for each. A bench chemist wants A + B; a computational chemist wants C + E; a QA
  reviewer wants D. Which one the UI is _for_ decides the order.
- **Is RDKit in the browser acceptable?** It unlocks canonical identity, substructure highlighting
  (US-15's motif rendering), and reliable reaction drawing. It costs multiple megabytes of WASM.
  `Molecule.tsx` already names substructure highlighting as the thing that would justify it.

  > **Since: answered yes**, on two of the three grounds named plus one this list missed
  > (validation), and not on the one it led with (see C5). The cost is paid only by a page that
  > shows chemistry: the entry chunk was unchanged across the swap and nothing is preloaded.

- **Does the deployment run the verifier and the harness?** `verifier_enabled`,
  `answer_shape_gate_enabled` and `harness_enabled` are all config. Concept E's grounding highlights
  and the plan surface are worth much less if they are off in production.
- **Should the UI ever compose a tool call directly?** Everything today goes through a chat turn.
  Concept D's structure-first entry stops short of this deliberately — it composes a _message_. A
  real "run this calculation" button would need the authorization story (`agent/authz.py`, the plan
  gate, `expensive: true`) thought through, and that is a larger question than a frontend concept.
