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
}

export interface ErrorEvent {
  type: 'error';
  /** Safe to show the user — the backend never puts stack traces here. Also how a turn that
   *  blew the 600s wall-clock limit is reported: as a final SSE event, not an HTTP error. */
  message: string;
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
}

export type ChemclawEvent =
  | QueuedEvent
  | PlanEvent
  | ToolCallEvent
  | TokenEvent
  | JobStartedEvent
  | JobCompletedEvent
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
  'capability_degraded',
  'tool_failed',
  'tool_result',
  'question',
  'note_proposed',
  'approval_request',
  'answer',
  'error',
]);

/*
 * `KNOWN_TOOLS` used to live here, claiming to be the list that picks an icon in the trace panel.
 * Nothing imported it. The icons come from an unrelated literal in `src/components/chem/toolIcons.tsx`,
 * so a maintainer who followed the comment and added a tool here would have shipped a wrench and
 * concluded the icon map was broken. Deleted rather than re-pointed: `toolIcons` keys off a plain
 * string with a neutral fallback on purpose, which is the same growth-tolerant posture as
 * `normalizeEvent` returning null for an unknown event type.
 */

const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const asStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

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
      };
    case 'error':
      return { type: 'error', message: asString(o.message, 'The turn failed.') };
    default:
      return null;
  }
}

/** Session ids are uuid4 hex from the backend: exactly 32 lowercase hex chars. The BFF uses
 *  this to validate path segments, which also makes traversal structurally impossible. */
export const SESSION_ID_RE = /^[0-9a-f]{32}$/;

/** The backend's own cap (`CHEMCLAW_SERVICE_MAX_MESSAGE_CHARS`); over it is a 422. */
export const MAX_MESSAGE_CHARS = 100_000;
