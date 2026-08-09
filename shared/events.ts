/**
 * The Chemclaw turn-event contract — a mirror of `service/events.py` in the backend repo.
 *
 * The backend streams these as Server-Sent Events, serialising each with `model_dump_json()`
 * and setting BOTH the SSE `event:` name and the JSON `type` field to the same discriminator.
 * We prefer the JSON field and fall back to the SSE name.
 *
 * Verified against 8fqycwdt8v-oss/Chemclaw3 (src/chemclaw/api/events.py). Fifteen members —
 * `question` and `note_proposed` are easy to miss, and `job_started` carries `kind`.
 *
 * It said ten for a while, and the two it was missing were the two that report trouble:
 * `capability_degraded` and `tool_failed`. Because `normalizeEvent` drops anything outside
 * `EVENT_TYPES`, an answer assembled without the ELN connector rendered as a confident, ordinary
 * answer. Forward-compatibility is the right default for an unknown event; it is the wrong
 * outcome for one that exists to qualify what the agent just said.
 *
 * Then it said fourteen, and the missing one was the same class of mistake with a longer fuse:
 * `job_failed`. A durable job that died rendered as "runs asynchronously" and stayed that way
 * forever, because the only event that would have corrected it was dropped in this file. The
 * lesson has now cost three events, so state it as a rule: **`EVENT_TYPES` is the gate.** Adding
 * an interface to the union without adding its discriminator here changes nothing at runtime.
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

export interface JobFailedEvent {
  type: 'job_failed';
  job_id: string;
  /** Why it died, in the service's own words. May be empty — a job can fail without the
   *  workflow having anything printable to say about it, and "" must still read as a failure. */
  reason: string;
}

/** The two terminal states of a durable job. Both arrive on the turn stream when the job finishes
 *  inside the turn, and on `GET /sessions/{id}/events` when it finishes after it. Anything that
 *  consumes one must consume the other, or a failure looks exactly like a job still running. */
export type JobTerminalEvent = JobCompletedEvent | JobFailedEvent;

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
  /** True exactly when `confidence < verifier_confidence_threshold`. The routing signal for a
   *  "needs expert review" affordance. */
  review_required: boolean;
  /**
   * Which verifier produced `confidence`, or `null` when none ran.
   *
   * Worth carrying rather than collapsing, because the same number means different things:
   * `citation-gate` is deterministic and scores an answer against the turn's own tool results,
   * and `judge` is an LLM scoring it against the claims. A surface that shows one score for both
   * is averaging two different measurements.
   */
  verified_by: 'judge' | 'citation-gate' | null;
}

/**
 * The closed set of reasons a turn ends badly. Mirrors the backend's `ErrorCode` `Literal`.
 *
 * Kept as a union rather than `string` on purpose: each of these routes to different copy and a
 * different offer to the user, and the compiler should complain when the backend adds one.
 * `normalizeEvent` still accepts an unknown code and maps it to `internal`, so a newer service
 * degrades to a generic error rather than dropping the event.
 */
export type ErrorCode =
  | 'internal'
  | 'storage_unavailable'
  | 'llm_timeout'
  | 'turn_timeout'
  | 'budget_exhausted'
  | 'loop_cap_reached'
  | 'bad_tool_arguments'
  | 'empty_answer';

const ERROR_CODES = new Set<string>([
  'internal',
  'storage_unavailable',
  'llm_timeout',
  'turn_timeout',
  'budget_exhausted',
  'loop_cap_reached',
  'bad_tool_arguments',
  'empty_answer',
]);

export interface ErrorEvent {
  type: 'error';
  /** Safe to show the user — the backend never puts stack traces here. Also how a turn that
   *  blew the wall-clock limit is reported: as a final SSE event, not an HTTP error. */
  message: string;
  /** What kind of failure, so the surface can say something better than "the turn failed" and
   *  can lock the composer on a `budget_exhausted` that arrived as an event rather than a 429. */
  code: ErrorCode;
  /** The backend's own judgement on whether sending the same turn again is worth doing. Not
   *  derivable from `code`: a `storage_unavailable` may or may not be, and it knows which. */
  retryable: boolean;
  /** Joins this failure to the audit trail and the server logs of the turn that produced it —
   *  the one thing a support conversation actually needs, and the one the user cannot look up. */
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
  /** Truncated by the backend exactly as `tool_call.arguments` is — a preview of the value, not
   *  the whole return. Raw; never `JSON.parse` it unguarded. */
  preview: string;
  /**
   * The content address of the untruncated result, fetchable at
   * `GET /sessions/{id}/tool-results/{ref}`. A SHA-256 hex digest of the result text.
   *
   * **Empty means "not stored"** — the store is off, the result was over the cap, or the write
   * failed — and the backend guarantees that is the only reading. So an empty string is the
   * check for whether to offer a "see the full result" affordance at all; there is no second
   * absence to disambiguate.
   *
   * The split is the point: the stream keeps its 200-character budget and carries a *reference*,
   * and a surface that decides to render one result pulls that one result, once.
   */
  result_ref: string;
  /** Note ids the result cited, untruncated even when `preview` is not — so a citation survives
   *  the cut that loses the sentence around it. */
  note_ids: string[];
  /** Numeric values the result carried, untruncated for the same reason. */
  numbers: number[];
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

/** Tools the agent advertises, used only to pick an icon/label in the trace panel. An unknown
 *  tool renders with a neutral fallback, so this list going stale is cosmetic — which is why it
 *  had drifted to 15 of the ~56 the service now registers. Grouped by the bundle that serves
 *  them, because that is how the backend adds them and how this list will next go stale. */
export const KNOWN_TOOLS = [
  // Evidence and the knowledge graph.
  'gather_evidence',
  'expand_note',
  'find_notes',
  'find_knowledge_gaps',
  'recall_observations',
  'propose_knowledge_note',
  'record_confirmed_answer',
  'record_failure',
  'request_note_reindex',
  // Fingerprint search.
  'similar_reactions',
  'similar_molecules',
  'substructure_matches',
  // Bench chemistry.
  'resolve_compound',
  'stoichiometry_table',
  'green_metrics',
  'render_structure',
  // Calculators.
  'compute_xtb_energy',
  'compute_electronic_properties',
  'compute_thermochemistry',
  'optimize_geometry',
  'predict_site_reactivity',
  'predict_pka',
  'predict_logd',
  'predict_solubility',
  'predict_developability_profile',
  'find_calculations',
  'calculator_trust',
  'calculator_outliers',
  'report_measurement',
  'list_artifacts',
  'fetch_artifact',
  // Durable calculation and QM jobs.
  'compute_reaction_energy',
  'compare_solvents',
  'scan_coordinate',
  'sample_conformers',
  'compute_interaction_energy',
  'compute_dft_energy',
  'submit_qm_job',
  'get_qm_job_status',
  // Safety.
  'screen_hazards',
  'screen_genotoxic_alerts',
  'ich_impurity_limit',
  // Design and optimisation.
  'suggest_next_experiment',
  'generate_screening_design',
  'campaign_progress',
  'predict_outcome',
  'resume_campaign',
  'start_optimization_campaign',
  // Jobs, reports and the session's own affordances.
  'get_durable_job_status',
  'find_past_jobs',
  'cancel_job',
  'request_development_report',
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

export type KnownTool = (typeof KNOWN_TOOLS)[number];

const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const asStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
/** Drops non-finite entries rather than passing `NaN`/`Infinity` on: this array feeds numeric
 *  rendering, and one `NaN` in it is a blank cell nobody can explain. */
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
    case 'job_completed':
      return {
        type: 'job_completed',
        job_id: asString(o.job_id),
        summary:
          typeof o.summary === 'object' && o.summary !== null ? (o.summary as JobSummary) : {},
      };
    case 'job_failed':
      // No fallback text for `reason`: the backend defaults it to "" and a job can genuinely fail
      // with nothing printable to say. Inventing a sentence here would put words in its mouth;
      // the surface decides what an empty reason reads as.
      return { type: 'job_failed', job_id: asString(o.job_id), reason: asString(o.reason) };
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
        result_ref: asString(o.result_ref),
        note_ids: asStringArray(o.note_ids),
        numbers: asNumberArray(o.numbers),
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
        verified_by:
          o.verified_by === 'judge' || o.verified_by === 'citation-gate' ? o.verified_by : null,
      };
    case 'error':
      return {
        type: 'error',
        message: asString(o.message, 'The turn failed.'),
        // An unrecognised code degrades to `internal` rather than dropping the event: a service
        // that grew a ninth code should still be able to end a turn here.
        code: ERROR_CODES.has(asString(o.code)) ? (o.code as ErrorCode) : 'internal',
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
