/**
 * The Chemclaw turn-event contract — a mirror of `service/events.py` in the backend repo.
 *
 * The backend streams these as Server-Sent Events, serialising each with `model_dump_json()`
 * and setting BOTH the SSE `event:` name and the JSON `type` field to the same discriminator.
 * We prefer the JSON field and fall back to the SSE name.
 *
 * Verified against 8fqycwdt8v-oss/Chemclaw3 @ a1bc379 (src/chemclaw/api/events.py). Fourteen
 * members — `question` and `note_proposed` are easy to miss, and `job_started` carries `kind`.
 *
 * It said ten for a while, and the two it was missing were the two that report trouble:
 * `capability_degraded` and `tool_failed`. Because `normalizeEvent` drops anything outside
 * `EVENT_TYPES`, an answer assembled without the ELN connector rendered as a confident, ordinary
 * answer. Forward-compatibility is the right default for an unknown event; it is the wrong
 * outcome for one that exists to qualify what the agent just said.
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
 * A durable job failed after its turn ended.
 *
 * This event existed upstream and was unknown here, which is not a cosmetic omission: because
 * `normalizeEvent` drops anything outside `EVENT_TYPES`, and `useJobFeed` matched only
 * `job_completed`, a job announced as started and then failed produced *nothing at all* on either
 * stream. The card said "running" forever and the only way to learn otherwise was to ask the agent.
 *
 * It is the exact hole the backend closed in `an-outage-is-not-a-missing-job`, reopened one layer
 * up — and the same shape as the `capability_degraded` omission this file's header already
 * describes: a degradation that renders as an ordinary, healthy result.
 */
export interface JobFailedEvent {
  type: 'job_failed';
  job_id: string;
  /** The innermost message in Temporal's failure chain — the one that says what actually broke. */
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
   * NOT a function of `confidence`, and the comment here used to say it was ("true exactly when
   * `confidence < verifier_confidence_threshold`"). Three independent conditions raise it, each
   * behind its own knob: the verifier scoring below threshold, a deterministic answer-shape gate
   * that produces no score at all, and `verified_by === 'citation-gate'` below. So it can be
   * `true` with `confidence` null, and `true` alongside a high `confidence`.
   */
  review_required: boolean;
  /**
   * Which check produced `confidence`, when one did. `null` means verification was off.
   *
   * `'citation-gate'` is the one that matters: it means the LLM judge did not run and the weaker
   * deterministic check scored this answer. The flag alone cannot carry that — a degraded turn and
   * a genuinely low-confidence turn both arrive as `review_required: true` — and a reviewer needs
   * to know whether the judge was even reachable.
   */
  verified_by: 'judge' | 'citation-gate' | null;
}

/**
 * The backend's closed error taxonomy. Each member is a *different thing for the user to do* —
 * retry, wait, narrow the question, quote an id to an operator — not a different place a traceback
 * came from, which is why it is this short.
 *
 * `'unknown'` is ours, not the backend's: a code we do not recognise must not be silently reshaped
 * into one we do.
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

export type ChemclawErrorCode = (typeof ERROR_CODES)[number] | 'unknown';

export interface ErrorEvent {
  type: 'error';
  /** Safe to show the user — the backend never puts stack traces here. Also how a turn that
   *  blew the 600s wall-clock limit is reported: as a final SSE event, not an HTTP error. */
  message: string;
  /**
   * What kind of failure this is.
   *
   * Was dropped entirely, which made every failure the same failure: a connector outage, an LLM
   * timeout, a database outage and a malformed tool argument all rendered as one sentence with no
   * useful next step, and "try again" was as likely to be wrong as right.
   *
   * **This event is not always terminal.** `loop_cap_reached` and `empty_answer` are emitted
   * *before* the `answer` they qualify — see `streamTurn`, which no longer treats an error frame
   * as the end of the turn.
   */
  code: ChemclawErrorCode;
  /**
   * Whether asking again, unchanged, could plausibly succeed.
   *
   * The discriminator for `budget_exhausted`, which is overloaded on the wire: `true` means
   * admission control shed the turn under load, `false` means the budget is genuinely spent.
   * Branch on this, never on the code alone — they call for opposite affordances.
   */
  retryable: boolean;
  /**
   * The id the audit trail is keyed on, and the only place it reaches a client.
   *
   * Not sensitive — a random per-turn hex string. Quoting it is what lets an operator find the
   * turn, so dropping it (as this did) is the difference between a reportable failure and an
   * unreportable one. Empty on route-level errors, which are raised before a turn is minted.
   */
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
   * Note ids this call returned. **Not truncated**, unlike `preview`, and that is the point.
   *
   * The backend split these out precisely because scoring a grounding claim against the first 200
   * characters of forty retrieved chunks graded real citations as fabrications. Prose for a human,
   * ids for a checker. A surface can answer "was this id actually in front of the model?" only
   * from here.
   */
  note_ids: string[];
  /** Figures this call returned, deduplicated and capped by the producer. Same split, same
   *  reason: the preview cannot answer "did a tool this turn return this number?". */
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

export const EVENT_TYPES = new Set<string>([
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
 * The wire fields each `normalizeEvent` branch actually reads, declared for the contract checker.
 *
 * Declared rather than extracted, because statically working out which properties a `switch` arm
 * touches is exactly the kind of analysis that is right until it quietly is not.
 *
 * `scripts/check-contract.mjs` checks this BOTH ways against the generated backend fixture. The
 * forward direction (we do not read a field the backend does not send) catches a typo. The reverse
 * direction — every backend field is either read here or named in the checker's `IGNORED_FIELDS`
 * — is the one that earns its keep: it is what would have caught `answer.verified_by`,
 * `tool_result.note_ids`/`numbers` and `error.code`/`retryable`/`correlation_id` being added
 * upstream and silently dropped here, each of which cost a real signal about how far to trust an
 * answer.
 */
export const EVENT_FIELDS: Record<ChemclawEventType, readonly string[]> = {
  queued: ['type'],
  plan: ['type', 'todos'],
  tool_call: ['type', 'tool', 'arguments'],
  token: ['type', 'text'],
  job_started: ['type', 'job_id', 'kind'],
  job_completed: ['type', 'job_id', 'summary'],
  job_failed: ['type', 'job_id', 'reason'],
  capability_degraded: ['type', 'connectors'],
  tool_failed: ['type', 'tool', 'message'],
  tool_result: ['type', 'tool', 'preview', 'note_ids', 'numbers'],
  question: ['type', 'question', 'options'],
  note_proposed: ['type', 'note_id', 'reference'],
  approval_request: ['type', 'prompt', 'approval_id'],
  answer: ['type', 'text', 'confidence', 'unsupported_claims', 'review_required', 'verified_by'],
  error: ['type', 'message', 'code', 'retryable', 'correlation_id'],
};

/** Tools the agent advertises, used only to pick an icon/label in the trace panel. An unknown
 *  tool renders with a neutral fallback, so this list going stale is cosmetic. */
export const KNOWN_TOOLS = [
  'gather_evidence',
  'expand_note',
  'find_notes',
  'compute_xtb_energy',
  'predict_pka',
  'predict_solubility',
  'submit_qm_job',
  'get_qm_job_status',
  'suggest_next_experiment',
  'screen_hazards',
  'propose_knowledge_note',
  'record_confirmed_answer',
  'similar_reactions',
  'similar_molecules',
  'substructure_matches',
] as const;

export type KnownTool = (typeof KNOWN_TOOLS)[number];

const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const asStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
/** Numbers only: a non-numeric entry is dropped rather than becoming `NaN`, which would render. */
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
      return {
        type: 'job_failed',
        job_id: asString(o.job_id),
        reason: asString(o.reason, 'The job failed.'),
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
        // An unrecognised code stays unrecognised. Coercing it to `internal` — the backend's own
        // default — would make a code we have not learned about yet indistinguishable from one
        // the backend deliberately classified as unclassified.
        code: ERROR_CODES.includes(o.code as (typeof ERROR_CODES)[number])
          ? (o.code as ChemclawErrorCode)
          : 'unknown',
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
