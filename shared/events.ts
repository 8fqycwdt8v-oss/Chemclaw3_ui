/**
 * The Chemclaw turn-event contract — a mirror of `service/events.py` in the backend repo.
 *
 * The backend streams these as Server-Sent Events, serialising each with `model_dump_json()`
 * and setting BOTH the SSE `event:` name and the JSON `type` field to the same discriminator.
 * We prefer the JSON field and fall back to the SSE name.
 *
 * Verified against 8fqycwdt8v-oss/Chemclaw3 @ 261b166 (src/chemclaw/api/events.py). Fifteen
 * members — `question` and `note_proposed` are easy to miss, and `job_started` carries `kind`.
 *
 * It said ten for a while, and the two it was missing were the two that report trouble:
 * `capability_degraded` and `tool_failed`. Because `normalizeEvent` drops anything outside
 * `EVENT_TYPES`, an answer assembled without the ELN connector rendered as a confident, ordinary
 * answer. Forward-compatibility is the right default for an unknown event; it is the wrong
 * outcome for one that exists to qualify what the agent just said.
 *
 * Then it said fourteen, and the missing one was `job_failed` — the same failure a third time, and
 * the worst of the three, because this event exists *specifically* to close a promise this UI had
 * already made. A durable job announced as running and then failed produced nothing on the wire we
 * kept, so the card said "runs asynchronously" for the rest of the conversation. Three misses with
 * one shape between them is what `scripts/check-openapi.mjs` is for.
 *
 * One field here runs ahead of `261b166` rather than behind it: `tool_result.result_ref` mirrors an
 * unmerged PR and says so at its declaration. It is the only optional field in the union, for that
 * reason and no other.
 *
 * This file is imported by both the SPA (bundled by Vite) and the mock backend (bundled by
 * esbuild). Keep it dependency-free.
 */

export interface QueuedEvent {
  type: 'queued';
  /* No payload. The backend emits this only when the turn actually had to wait for an admission
   * permit, and it is then the FIRST event of that turn. A turn that gets a permit immediately —
   * the normal case — never sends one, so seeing it at all is the information. */
}

export interface PlanEvent {
  type: 'plan';
  /** The harness's current todo list. Emitted only when the list CHANGED, so each one is a
   *  genuine revision rather than a repeat. Absent entirely unless harness mode is on. */
  todos: string[];
}

export interface ToolCallEvent {
  type: 'tool_call';
  tool: string;
  /** A RAW string truncated to 200 chars by the backend — NOT parsed JSON, and possibly cut
   *  mid-token. Never `JSON.parse` this unguarded. */
  arguments: string;
}

export interface TokenEvent {
  type: 'token';
  text: string;
}

export interface JobStartedEvent {
  type: 'job_started';
  job_id: string;
  /** "qm" | "report" | "campaign" | "job" — lets a surface label the job without parsing the id. */
  kind: string;
}

/** The one structured chemistry payload the backend produces. The backend types it as a bare
 *  `dict[str, object]`, so every key is unverified — treat all of them as optional. */
export interface JobSummary {
  job_id?: string;
  molecule_smiles?: string;
  total_energy_hartree?: number;
  converged?: boolean;
  [key: string]: unknown;
}

export interface JobCompletedEvent {
  type: 'job_completed';
  job_id: string;
  summary: JobSummary;
}

/**
 * A durable job failed after the turn that launched it had already ended.
 *
 * The counterpart to `job_completed`, and the one that closes the promise. `job_started` says a job
 * is running and the surface renders that; without this event the only ending on the wire was the
 * happy one, so a failed job kept its "runs asynchronously" label indefinitely and the failure was
 * reachable only by polling with an id the chemist would have had to keep.
 *
 * Arrives on `GET /sessions/{id}/events` (the push-back stream), not on the turn stream — by
 * definition, since a job that failed *during* its turn is reported inside it.
 */
export interface JobFailedEvent {
  type: 'job_failed';
  job_id: string;
  /** The innermost message in Temporal's failure chain: the outer ones say "Child Workflow
   *  execution failed" and this one says what actually went wrong. May be empty. */
  reason: string;
}

export interface QuestionEvent {
  type: 'question';
  question: string;
  /** Concrete choices when the agent can enumerate them, so a surface can render buttons
   *  instead of free text. Often empty. */
  options: string[];
}

export interface NoteProposedEvent {
  type: 'note_proposed';
  note_id: string;
  /** The branch/PR reference the note was opened on, for the PR-gated knowledge graph. */
  reference: string;
}

export interface ApprovalRequestEvent {
  type: 'approval_request';
  prompt: string;
  /** The durable hold's handle, answerable via `POST /approvals/{id}/decision`. Empty string
   *  for a plan-approval prompt, which is answered by sending the next chat message instead. */
  approval_id: string;
}

export interface AnswerEvent {
  type: 'answer';
  /**
   * The FULL assembled answer — i.e. the concatenation of every preceding `token.text`.
   *
   * Rendering this *and* the accumulated tokens double-renders the whole answer. See
   * `src/state/chatStore.ts`: the store keeps `streamedText` and `finalText` apart and the
   * renderer picks one. There is deliberately no code path that concatenates them.
   */
  text: string;
  /** Verifier citation-faithfulness score in [0,1]. `null` unless the verifier is enabled. */
  confidence: number | null;
  unsupported_claims: string[];
  /**
   * The routing signal for a "needs expert review" affordance.
   *
   * NOT a function of `confidence` alone, which is why it is its own field: the deterministic
   * answer-shape gate can raise it while leaving `confidence` at `null` — it found a
   * method-parameter shape no tool produced, and that is not a score. So `review_required` can be
   * true with no number beside it.
   */
  review_required: boolean;
  /**
   * Which check produced `confidence`, when one did. `null` means verification was off.
   *
   * The flag above cannot carry this. A turn routed to review because the judge was unreachable
   * and a turn routed there because the judge scored it badly both arrive as
   * `review_required: true`, and a reviewer needs to know which — `"citation-gate"` means the
   * check that earns confidence did not run. The flag is the safety property; this is the
   * transparency, and rendering them as one thing loses the second.
   */
  verified_by: 'judge' | 'citation-gate' | null;
}

/**
 * The closed taxonomy of turn failures.
 *
 * Each member is a *different thing for the user to do* — retry, wait, narrow the question, fix the
 * input, ask an operator — not a different place the traceback came from, which is why it is this
 * short. `empty_answer` is the odd one and the most useful: the turn ran to completion and wrote
 * nothing, so a surface should offer "ask something narrower" rather than "an internal error
 * occurred".
 */
export const ERROR_CODES = [
  'internal',
  'storage_unavailable',
  'llm_timeout',
  'turn_timeout',
  'budget_exhausted',
  'loop_cap_reached',
  'bad_tool_arguments',
  'empty_answer',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const ERROR_CODE_SET = new Set<string>(ERROR_CODES);

export interface ErrorEvent {
  type: 'error';
  /** Safe to show the user — the backend never puts stack traces here. Also how a turn that
   *  blew the 600s wall-clock limit is reported: as a final SSE event, not an HTTP error. */
  message: string;
  /** `internal` is the honest default for an unclassified failure — and is what an older backend,
   *  which sends no code at all, is read as. */
  code: ErrorCode;
  /** Whether asking again, unchanged, could plausibly succeed. Telling a user to retry a malformed
   *  tool argument wastes their time and the deployment's tokens. */
  retryable: boolean;
  /** The id the **audit trail** is keyed on — not the session id, which the user already has.
   *  Quoting it is what lets an operator find the turn. Not sensitive: random per-turn hex. */
  correlation_id: string;
}

export interface CapabilityDegradedEvent {
  type: 'capability_degraded';
  /** Connectors that did not come up for this turn, so their tools were absent from it. Emitted
   *  before the first token, so a surface can mark the answer as partial while it streams rather
   *  than retroactively. The turn is NOT failed by this — it costs tools, not the conversation. */
  connectors: string[];
}

export interface ToolFailedEvent {
  type: 'tool_failed';
  /** One tool call raised; the turn continues. Distinct from `error`, which ends it: the model
   *  can route around a failed call, and when it cannot, this is the only event that says why. */
  tool: string;
  message: string;
}

export interface ToolResultEvent {
  type: 'tool_result';
  /** What a call returned, as data rather than as the model's paraphrase of it. Success only:
   *  a call that raised arrives as `tool_failed` instead, and the two are exhaustive — which is
   *  why there is no `ok` flag to check. */
  tool: string;
  /**
   * Truncated by the backend exactly as `tool_call.arguments` is — a preview of the value, not
   * the whole return. Raw; never `JSON.parse` it unguarded.
   *
   * **And never render chemistry from it.** A 200-char cut lands anywhere, including the middle of
   * a SMILES string — and a truncated SMILES frequently still *parses*, as a different, smaller
   * molecule. Prose cut short reads as cut short; a structure cut short reads as a structure. The
   * two fields below exist precisely so a consumer never has to mine this string for data.
   */
  preview: string;
  /**
   * The note ids the call returned, in full — **not** truncated, because it answers a different
   * question from `preview`.
   *
   * A grounding check asks "was this id in front of the model this turn?", and scoring that against
   * the preview means scoring 40 retrieved chunks against the first 200 characters of them. A live
   * backend run graded 19 of 36 answers as fabrication that way, and nine of nine verdicts checked
   * were false — every one an id the tool really had returned.
   */
  note_ids: string[];
  /**
   * The distinct numeric values the call returned, in full and deduplicated.
   *
   * The same split as `note_ids`, one step further on: prose for a human, values for a scorer. It
   * is the only structured chemistry data currently on the wire, so it is what a provenance
   * overlay can honestly check an answer's figures against.
   *
   * Bounded by the producer (`stream_max_result_numbers`, default 512) and far out of reach in
   * real traffic — 5 values for an ICH lookup, 27 for a charge table, 49 for a full
   * electronic-properties run. The backend logs when it does bound it, because a silent truncation
   * reads as completeness.
   */
  numbers: number[];
  /**
   * A reference to this result's full text, fetchable from `GET /sessions/{id}/tool-results/{ref}`
   * — the SHA-256 of the text itself, so the same result from the same call is the same ref.
   *
   * The third field split out of `preview` by the argument the two above already make, and the one
   * that finishes it. `note_ids` answers "which ids", `numbers` answers "which figures"; neither
   * can give a consumer the result's **shape**, so a `ScreenResult`'s severities and citations, a
   * `ChargeTable`'s rows and a solvent ranking still reached the chemist only as prose the model
   * wrote about them. The payload deliberately stays off the wire: a surface pulls the one result
   * it decided to render, once, rather than every result being streamed to every consumer.
   *
   * **Empty means "not stored" — three causes, one meaning**: the store is off, the result was
   * over `stream_max_result_bytes` (128 KiB, and refused whole rather than trimmed, because half a
   * `ScreenResult` is still valid JSON and renders as a *complete* hazard screen with flags
   * missing), or the write failed. So a consumer has exactly one thing to check, and the answer is
   * always "fall back to `preview`".
   *
   * Optional here and required-with-a-default upstream, which is the one place this mirror is
   * knowingly looser than the contract it mirrors: the field comes from an **unmerged** PR
   * (8fqycwdt8v-oss/Chemclaw3 #157, branch `claude/tool-result-surface`), so every backend in
   * service today omits it from the frame entirely. Absent and empty therefore have to read the
   * same — and they do, because "not stored" is what both mean, and `isFetchableRef`
   * (`src/chem/results.ts`) is the one predicate that decides it. That module is also the single
   * place that knows the route and the response shape behind this handle; when the PR lands, this
   * becomes required like its neighbours and nothing that reads it changes.
   */
  result_ref?: string;
}

export type ChemclawEvent =
  | QueuedEvent
  | PlanEvent
  | ToolCallEvent
  | TokenEvent
  | JobStartedEvent
  | JobCompletedEvent
  | JobFailedEvent
  | CapabilityDegradedEvent
  | ToolFailedEvent
  | ToolResultEvent
  | QuestionEvent
  | NoteProposedEvent
  | ApprovalRequestEvent
  | AnswerEvent
  | ErrorEvent;

export type ChemclawEventType = ChemclawEvent['type'];

const EVENT_TYPES = new Set<string>([
  'queued',
  'plan',
  'tool_call',
  'token',
  'job_started',
  'job_completed',
  'job_failed',
  'capability_degraded',
  'tool_failed',
  'tool_result',
  'question',
  'note_proposed',
  'approval_request',
  'answer',
  'error',
]);

/**
 * Every tool the agent advertises — the closed set of names the frontend's per-tool tables are
 * allowed to key on.
 *
 * It used to say it picked the trace panel's icon, and it did not: `TracePanel` has always had its
 * own `TOOL_ICON` map and never imported this. So there were three parallel tool tables (this one,
 * `TOOL_ICON`, and `TOOL_METHOD` in `src/chem/provenance.ts`), one of which nothing read, and the
 * docstring on the unread one claimed it was the one in use.
 *
 * It is now the **key domain** of the other two: both are declared as
 * `Partial<Record<KnownTool, …>>`, so an entry naming a tool the backend does not have is a
 * compile error rather than a row that can never match. That is exactly the failure this list
 * itself once had — it named `submit_qm_job` and `get_qm_job_status`, which the backend had
 * replaced with `compute_dft_energy` and `get_durable_job_status`, so the two entries a chemist
 * watching a long QM run stares at were the two that could never fire.
 *
 * What it deliberately does NOT do is gate lookups. A tool absent from here still renders, with the
 * neutral fallbacks the tables already had: the backend adds tools without asking this repo, and a
 * frontend that refused to draw a row for one it had not heard of would be worse than one whose
 * icon is a wrench.
 *
 * Two sources, kept apart because they are discovered differently and a reader looking for a name
 * needs to know which half to search: the seven connector bundles declare theirs in
 * `connector.yaml` (`tools:` plus each `jobs: - name:`), and the in-process ones declare themselves
 * with a `@tool` decorator at their definition site.
 */
const CONNECTOR_TOOLS = [
  // chem — RDKit, pure and synchronous
  'resolve_compound',
  'stoichiometry_table',
  'green_metrics',
  'render_structure',
  // calc — the fast cached calculators, and the calibration ledger over them
  'compute_xtb_energy',
  'compute_electronic_properties',
  'predict_site_reactivity',
  'optimize_geometry',
  'compute_thermochemistry',
  'predict_pka',
  'predict_solubility',
  'predict_logd',
  'predict_developability_profile',
  'calculator_trust',
  'calculator_outliers',
  'find_calculations',
  'list_artifacts',
  'fetch_artifact',
  'report_measurement',
  // calc — the durable half: same capability, minutes rather than seconds
  'compute_reaction_energy',
  'compare_solvents',
  'scan_coordinate',
  'sample_conformers',
  'compute_interaction_energy',
  // qm — jobs only; there is no sub-second DFT tool to serve
  'compute_dft_energy',
  // bo — experiment design, inline and durable
  'suggest_next_experiment',
  'resume_campaign',
  'generate_screening_design',
  'campaign_progress',
  'predict_outcome',
  'start_optimization_campaign',
  // safety — three separately-governed cited tables
  'screen_hazards',
  'screen_genotoxic_alerts',
  'ich_impurity_limit',
  // molfp / rxnfp — search over the fingerprint indexes
  'similar_molecules',
  'substructure_matches',
  'similar_reactions',
] as const;

const IN_PROCESS_TOOLS = [
  'gather_evidence',
  'find_notes',
  'expand_note',
  'find_knowledge_gaps',
  'propose_knowledge_note',
  'record_failure',
  'record_confirmed_answer',
  'recall_observations',
  'request_development_report',
  'get_durable_job_status',
  'find_past_jobs',
  'ask_clarifying_question',
  'list_attachments',
  'read_attachment',
  'remember_preference',
  'recall_preferences',
  'forget_preference',
  'watch_for',
  'list_watches',
  'stop_watching',
] as const;

const KNOWN_TOOLS = [...CONNECTOR_TOOLS, ...IN_PROCESS_TOOLS] as const;

export type KnownTool = (typeof KNOWN_TOOLS)[number];

const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const asStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

/**
 * Numbers only, and finite ones.
 *
 * Not `Number(x)`: JSON gives us `null` for a non-finite float and `Number(null)` is 0 — which
 * would invent a value the tool never returned and hand it to a grounding check as evidence. A
 * value we cannot read is dropped, because this list's whole contract is that everything in it was
 * really returned.
 */
const asNumberArray = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : [];

/**
 * Coerce one decoded SSE frame into a `ChemclawEvent`, or `null` if it is not one we know.
 *
 * Returning `null` rather than throwing is deliberate: the backend's event union is explicitly
 * designed to grow ("adding an event is a new class here plus one branch in the runner and the
 * UI"), so an older frontend must ignore a newer event rather than break the turn.
 *
 * Every field is defensively coerced because these values cross a process boundary and a
 * malformed frame should cost one event, not the whole conversation.
 */
export function normalizeEvent(raw: unknown, sseEventName?: string): ChemclawEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const type = typeof o.type === 'string' ? o.type : sseEventName;
  if (typeof type !== 'string' || !EVENT_TYPES.has(type)) return null;

  switch (type) {
    case 'queued':
      return { type: 'queued' };
    case 'plan':
      return { type: 'plan', todos: asStringArray(o.todos) };
    case 'tool_call':
      return {
        type: 'tool_call',
        tool: asString(o.tool, 'unknown'),
        arguments: asString(o.arguments),
      };
    case 'token':
      return { type: 'token', text: asString(o.text) };
    case 'job_started':
      return { type: 'job_started', job_id: asString(o.job_id), kind: asString(o.kind, 'job') };
    case 'job_failed':
      return { type: 'job_failed', job_id: asString(o.job_id), reason: asString(o.reason) };
    case 'job_completed':
      return {
        type: 'job_completed',
        job_id: asString(o.job_id),
        summary:
          typeof o.summary === 'object' && o.summary !== null ? (o.summary as JobSummary) : {},
      };
    case 'capability_degraded':
      return { type: 'capability_degraded', connectors: asStringArray(o.connectors) };
    case 'tool_failed':
      return {
        type: 'tool_failed',
        tool: asString(o.tool, 'unknown'),
        message: asString(o.message, 'The tool call failed.'),
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool: asString(o.tool, 'unknown'),
        preview: asString(o.preview),
        note_ids: asStringArray(o.note_ids),
        numbers: asNumberArray(o.numbers),
        // Carried only when the frame carried one — deliberately not the discipline the two lists
        // above follow, and the difference is the whole reason each is written the way it is. An
        // absent `note_ids` defaulted to `[]` because absent must not read as a wildcard to a
        // grounding check; here absent and empty already mean one thing ("not stored — render the
        // preview"), so there is no second reading to close off. And the field mirrors an unmerged
        // PR: a frame from a backend that has never heard of it normalises to exactly the event it
        // has always normalised to.
        ...(typeof o.result_ref === 'string' ? { result_ref: o.result_ref } : {}),
      };
    case 'question':
      return {
        type: 'question',
        question: asString(o.question),
        options: asStringArray(o.options),
      };
    case 'note_proposed':
      return {
        type: 'note_proposed',
        note_id: asString(o.note_id),
        reference: asString(o.reference),
      };
    case 'approval_request':
      return {
        type: 'approval_request',
        prompt: asString(o.prompt, 'Approval requested.'),
        approval_id: asString(o.approval_id),
      };
    case 'answer':
      return {
        type: 'answer',
        text: asString(o.text),
        confidence: typeof o.confidence === 'number' ? o.confidence : null,
        unsupported_claims: asStringArray(o.unsupported_claims),
        review_required: o.review_required === true,
        // Anything we do not recognise reads as "verification was off" rather than as a verdict
        // we cannot name — the same direction the flag above already errs in.
        verified_by:
          o.verified_by === 'judge' || o.verified_by === 'citation-gate' ? o.verified_by : null,
      };
    case 'error':
      return {
        type: 'error',
        message: asString(o.message, 'The turn failed.'),
        // A backend that predates these fields sends none of them, and `internal` + not-retryable
        // is exactly how such a failure was treated before they existed.
        code: ERROR_CODE_SET.has(asString(o.code)) ? (o.code as ErrorCode) : 'internal',
        retryable: o.retryable === true,
        correlation_id: asString(o.correlation_id),
      };
    default:
      return null;
  }
}

/** Session ids are uuid4 hex from the backend: exactly 32 lowercase hex chars. The BFF uses
 *  this to validate path segments, which also makes traversal structurally impossible. */
export const SESSION_ID_RE = /^[0-9a-f]{32}$/;

/** The backend's own cap (`CHEMCLAW_SERVICE_MAX_MESSAGE_CHARS`); over it is a 422. */
export const MAX_MESSAGE_CHARS = 100_000;
