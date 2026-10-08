/**
 * The turn-event contract as this UI reads it: the generated schemas (`shared/generated/events.ts`,
 * from the pinned core contract) plus the readings that are a UI decision.
 *
 * The backend streams Server-Sent Events, setting both the SSE `event:` name and the JSON `type` to
 * the same discriminator; the JSON field wins. Each member is a tolerant valibot schema and its type
 * is `v.InferOutput` of it, so a field cannot exist in the type and be missing from the decoder.
 *
 * What is written here, and why it is not generated:
 *  - `refine` states a reading the document leaves open (the fallback for a closed set, a field
 *    read as open text where the document narrows it). `STATED_READINGS` lists them.
 *  - `WIRE_ALIASES` maps an older spelling of a wire name onto the current one.
 *  - `normalizeEvent` drops a discriminator this build does not know: the union is designed to
 *    grow, so an older frontend ignores newer events instead of failing on them.
 *
 * Imported by the SPA, the BFF and the e2e fixture service; `valibot` is its one dependency
 * (`docs/dependencies.md`).
 */

import * as v from 'valibot';
import { oneOf, text } from './eventCoercion.ts';
import * as G from './generated/events.ts';
import type { Loosen } from './wire.ts';

/* ── readings the document leaves to the reader ─────────────────────────── */

/** Every `Model.field` stated by a `refine` call, for the test that checks no guess is left. */
export const STATED_READINGS: string[] = [];

/**
 * A generated member with some fields read differently. Keys must name fields the member has, and
 * the result's type follows the replacement — so a field the contract drops fails the typecheck.
 */
function refine<
  M extends keyof typeof G.EVENT_MODELS,
  E extends v.ObjectEntries,
  O extends { [K in keyof E]?: v.GenericSchema },
>(
  kind: M,
  schema: v.ObjectSchema<E, undefined>,
  overrides: O & { [K in Exclude<keyof O, keyof E>]: never },
): v.ObjectSchema<Omit<E, keyof O> & O, undefined> {
  for (const field of Object.keys(overrides))
    STATED_READINGS.push(`${G.EVENT_MODELS[kind]}.${field}`);
  return v.object({ ...schema.entries, ...overrides }) as unknown as v.ObjectSchema<
    Omit<E, keyof O> & O,
    undefined
  >;
}

/**
 * The one structured chemistry payload the backend produces. The backend types it as a bare
 * `dict[str, object]`, so every key is unverified — treat all of them as optional.
 */
export interface JobSummary {
  job_id?: string;
  molecule_smiles?: string;
  total_energy_hartree?: number;
  converged?: boolean;
  /** A development report's `report` note (`request_development_report`). */
  note_id?: string;
  /**
   * The `document` artefact a development report wrote into the asking session (`xb-` + 16 hex).
   * The job card's Open report focuses it; `reportExhibitOf` validates it against `EXHIBIT_ID_RE`
   * first.
   */
  exhibit_id?: string;
  [key: string]: unknown;
}

const jobSummary = () =>
  v.fallback(
    v.custom<JobSummary>((x) => typeof x === 'object' && x !== null),
    {} as JobSummary,
  );

/**
 * One number a structured tool result returned, under the tool's own key path. `label` is never
 * prettified and `unit` is only a `unit`/`units` string beside it in the payload. Never infer
 * relationships between values (e.g. an uncertainty).
 */
export interface ResultValue {
  label: string;
  value: number;
  unit: string;
}

/** The labelled figures, dropping unlabelled or non-finite values. */
const resultValues = () =>
  v.fallback(
    v.pipe(
      v.array(v.unknown()),
      v.transform((entries) =>
        entries.flatMap((entry): ResultValue[] => {
          if (typeof entry !== 'object' || entry === null) return [];
          const row = entry as Record<string, unknown>;
          const label = typeof row.label === 'string' ? row.label : '';
          const value = row.value;
          if (!label || typeof value !== 'number' || !Number.isFinite(value)) return [];
          return [{ label, value, unit: typeof row.unit === 'string' ? row.unit : '' }];
        }),
      ),
    ),
    [] as ResultValue[],
  );

const UNKNOWN_TOOL = text('unknown');

/*
 * Each member, with the readings above applied. The `tool` / `source` fallbacks name the thing a
 * card cannot do without; the closed sets fall to the reading that claims the least (`revised` may
 * not open the pane, `agent` captions a chart as transcribed rather than vouched for).
 */

/**
 * A place in a session's line: a non-negative integer, or `null` (anything else reads as no place,
 * where a count would truncate it).
 */
const placeOrNull = () =>
  v.fallback(
    v.nullable(
      v.pipe(
        v.number(),
        v.check((n: number) => Number.isSafeInteger(n) && n >= 0),
      ),
    ),
    null,
  );

const queuedEvent = refine('queued', G.queuedEvent, {
  ticket: placeOrNull(),
  position: placeOrNull(),
});
const planEvent = G.planEvent;
const toolCallEvent = refine('tool_call', G.toolCallEvent, { tool: UNKNOWN_TOOL });
const tokenEvent = G.tokenEvent;
const jobStartedEvent = G.jobStartedEvent;
const toolQueuedEvent = refine('tool_queued', G.toolQueuedEvent, {
  tool: UNKNOWN_TOOL,
  state: oneOf(['queued', 'running'] as const, 'queued'),
});
const jobCompletedEvent = refine('job_completed', G.jobCompletedEvent, { summary: jobSummary() });
const jobFailedEvent = G.jobFailedEvent;
const awaitingAnswerEvent = G.awaitingAnswerEvent;
const capabilityDegradedEvent = G.capabilityDegradedEvent;
const noteRecordedEvent = G.noteRecordedEvent;
const approvalRequestEvent = refine('approval_request', G.approvalRequestEvent, {
  prompt: text('Approval requested.'),
});
const questionEvent = G.questionEvent;
const answerEvent = G.answerEvent;
const toolFailedEvent = refine('tool_failed', G.toolFailedEvent, {
  tool: UNKNOWN_TOOL,
  message: text('The tool call failed.'),
});
const toolResultEvent = refine('tool_result', G.toolResultEvent, {
  tool: UNKNOWN_TOOL,
  values: resultValues(),
});
const evidenceSourceEvent = refine('evidence_source', G.evidenceSourceEvent, {
  source: UNKNOWN_TOOL,
});
const handoffEvent = G.handoffEvent;
const exhibitEvent = refine('exhibit', G.exhibitEvent, {
  // Open rather than narrowed, as `ExhibitHeader.kind` is: a card for a kind this build does not
  // know still says that an artefact exists.
  kind: text(),
  op: oneOf(['created', 'revised'] as const, 'revised'),
  author_kind: oneOf(['agent', 'human'] as const, 'agent'),
});
const exhibitDraftEvent = refine('exhibit_draft', G.exhibitDraftEvent, {
  kind: text(),
  op: oneOf(['create', 'revise'] as const, 'revise'),
});
const errorEvent = refine('error', G.errorEvent, { message: text('The turn failed.') });

/* ── the types ───────────────────────────────────────────────────────────── */

export type QueuedEvent = v.InferOutput<typeof queuedEvent>;
export type PlanEvent = v.InferOutput<typeof planEvent>;
export type ToolCallEvent = Loosen<v.InferOutput<typeof toolCallEvent>, 'agent'>;
export type TokenEvent = Loosen<v.InferOutput<typeof tokenEvent>, 'agent'>;
export type JobStartedEvent = Loosen<v.InferOutput<typeof jobStartedEvent>, 'plan_step'>;
export type ToolQueuedEvent = Loosen<v.InferOutput<typeof toolQueuedEvent>, 'waiting'>;
export type JobCompletedEvent = v.InferOutput<typeof jobCompletedEvent>;
export type JobFailedEvent = v.InferOutput<typeof jobFailedEvent>;
export type AwaitingAnswerEvent = v.InferOutput<typeof awaitingAnswerEvent>;
export type CapabilityDegradedEvent = v.InferOutput<typeof capabilityDegradedEvent>;
export type NoteRecordedEvent = v.InferOutput<typeof noteRecordedEvent>;
export type ApprovalRequestEvent = v.InferOutput<typeof approvalRequestEvent>;
export type QuestionEvent = v.InferOutput<typeof questionEvent>;
export type AnswerEvent = v.InferOutput<typeof answerEvent>;
export type ToolFailedEvent = Loosen<
  v.InferOutput<typeof toolFailedEvent>,
  'reason' | 'agent' | 'call_id'
>;
export type ToolResultEvent = Loosen<
  v.InferOutput<typeof toolResultEvent>,
  'result_inline' | 'result_cut' | 'values' | 'agent'
>;
export type EvidenceSourceEvent = Loosen<v.InferOutput<typeof evidenceSourceEvent>, 'failed'>;
export type HandoffEvent = v.InferOutput<typeof handoffEvent>;
export type ExhibitEvent = Loosen<v.InferOutput<typeof exhibitEvent>, 'call_id'>;
export type ExhibitDraftEvent = v.InferOutput<typeof exhibitDraftEvent>;
export type ErrorEvent = v.InferOutput<typeof errorEvent>;

/**
 * The two terminal states of a durable job, on the turn stream or `GET /sessions/{id}/events`.
 * Consume both, or a failure looks like a running job.
 */
export type JobTerminalEvent = JobCompletedEvent | JobFailedEvent;

/** The closed sets the events carry, named for the code that switches on them. */
export type ErrorCode = ErrorEvent['code'];
export type RefusalReason = NonNullable<G.ToolFailedEvent['reason']>;
export type AnswerCheck = G.AnswerEvent['checks_run'][number];

/** Every member of `RefusalReason`, for exhaustiveness checks. */
export const REFUSAL_REASONS: readonly RefusalReason[] = G.EVENT_ENUMS['ToolFailedEvent.reason'];

export type TurnEventKind = G.TurnEventKind;

export type ChemclawEvent =
  | QueuedEvent
  | PlanEvent
  | ToolCallEvent
  | TokenEvent
  | JobStartedEvent
  | ToolQueuedEvent
  | JobCompletedEvent
  | JobFailedEvent
  | AwaitingAnswerEvent
  | CapabilityDegradedEvent
  | ToolFailedEvent
  | ToolResultEvent
  | EvidenceSourceEvent
  | HandoffEvent
  | ExhibitEvent
  | ExhibitDraftEvent
  | QuestionEvent
  | NoteRecordedEvent
  | ApprovalRequestEvent
  | AnswerEvent
  | ErrorEvent;

export type ChemclawEventType = ChemclawEvent['type'];

/**
 * Every member, by discriminator. Typed over `TurnEventKind`, so a kind the contract gains fails the
 * typecheck here until a member is named for it — and a kind it loses does the same.
 */
const EVENT_MEMBERS = {
  queued: queuedEvent,
  plan: planEvent,
  tool_call: toolCallEvent,
  token: tokenEvent,
  job_started: jobStartedEvent,
  tool_queued: toolQueuedEvent,
  job_completed: jobCompletedEvent,
  job_failed: jobFailedEvent,
  awaiting_answer: awaitingAnswerEvent,
  capability_degraded: capabilityDegradedEvent,
  note_recorded: noteRecordedEvent,
  approval_request: approvalRequestEvent,
  question: questionEvent,
  answer: answerEvent,
  tool_failed: toolFailedEvent,
  tool_result: toolResultEvent,
  evidence_source: evidenceSourceEvent,
  handoff: handoffEvent,
  exhibit: exhibitEvent,
  exhibit_draft: exhibitDraftEvent,
  error: errorEvent,
} as const satisfies Record<TurnEventKind, v.GenericSchema>;

/**
 * Older wire spellings of members already declared, resolved before dispatch. The service renamed
 * `note_proposed` to `note_recorded`; the old name stays admitted until every deployment has rolled
 * forward (`ISSUES.md` Issue 13).
 */
const WIRE_ALIASES: Readonly<Record<string, TurnEventKind>> = { note_proposed: 'note_recorded' };

/** The decoder. One `v.variant` over the members, dispatching on the discriminator. */
const eventSchema = v.variant(
  'type',
  Object.values(EVENT_MEMBERS) as unknown as [
    (typeof EVENT_MEMBERS)[TurnEventKind],
    ...(typeof EVENT_MEMBERS)[TurnEventKind][],
  ],
);

/** Every wire name this client admits, derived from the schemas. Exported for tests. */
export const EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  ...Object.keys(EVENT_MEMBERS),
  ...Object.keys(WIRE_ALIASES),
]);

/**
 * Coerce one decoded SSE frame into a `ChemclawEvent`, or `null` for an unknown discriminator (the
 * union is designed to grow, so an older frontend ignores newer events). Every field has a
 * fallback, so a malformed field never drops the event. The payload's `type` wins over the SSE
 * name; `WIRE_ALIASES` is applied before dispatch.
 */
export function normalizeEvent(raw: unknown, sseEventName?: string): ChemclawEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const frame = raw as Record<string, unknown>;
  const wireName = typeof frame.type === 'string' ? frame.type : sseEventName;
  if (typeof wireName !== 'string') return null;
  const parsed = v.safeParse(eventSchema, {
    ...frame,
    type: WIRE_ALIASES[wireName] ?? wireName,
  });
  return parsed.success ? (parsed.output as ChemclawEvent) : null;
}

/** Session ids are uuid4 hex from the backend: exactly 32 lowercase hex chars. The BFF uses
 *  this to validate path segments, which also makes traversal structurally impossible. */
export const SESSION_ID_RE = /^[0-9a-f]{32}$/;

/**
 * The backend's default message cap (`CHEMCLAW_SERVICE_MAX_MESSAGE_CHARS`); over it is a 422. A
 * fallback only: the live value comes through `/config.js` (`config.maxMessageChars`).
 */
export const MAX_MESSAGE_CHARS = 100_000;

/**
 * Whether a configured cap is usable — a positive integer, as the backend requires. The one
 * predicate both the BFF (refuses to boot) and the SPA (keeps the default) use.
 */
export const isUsableMessageCap = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;
