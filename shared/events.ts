/**
 * The Chemclaw turn-event contract — a hand-written mirror of `src/chemclaw/api/events.py`.
 *
 * The backend streams Server-Sent Events, setting both the SSE `event:` name and the JSON `type` to
 * the same discriminator; the JSON field wins. Each member is a valibot schema and its type is
 * `v.InferOutput` of it, so a field cannot exist in the type and be missing from the decoder.
 * `EVENT_MEMBERS` is the gate: an event not listed there is dropped by `normalizeEvent`. A backend
 * change to this contract is not finished until it lands here; `tests/eventContract.test.ts` and
 * `tests/backendContract.test.ts` check it.
 *
 * Imported by the SPA, the BFF and the e2e fixture service; `valibot` is its one dependency
 * (`docs/dependencies.md`).
 */

import * as v from 'valibot';

/**
 * Make some keys optional to write while present to read. Several fields are always populated by
 * `normalizeEvent` but defaulted by the backend, so constructors (tests, fixtures) need not name
 * them. Can only remove a `?`.
 */
type Loosen<T, K extends keyof T> = Omit<T, K> & { [P in K]?: T[P] };

/*
 * ── the coercion vocabulary ── One helper per shape this wire carries. Each is a `v.fallback`, so
 * a malformed field costs that field and never the event.
 */

/** A string, or the stated fallback. The shape most of this wire has. */
const text = (fallback = '') => v.fallback(v.string(), fallback);

/** Every entry stringified; a non-array is empty. */
const textList = () =>
  v.fallback(
    v.pipe(
      v.array(v.unknown()),
      v.transform((entries) => entries.map(String)),
    ),
    [] as string[],
  );

/** Finite numbers only. This array feeds numeric rendering, and one `NaN` in it is a blank cell
 *  nobody can explain. */
const numberList = () =>
  v.fallback(
    v.pipe(
      v.array(v.unknown()),
      v.transform((entries) =>
        entries.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)),
      ),
    ),
    [] as number[],
  );

/** A count, never `NaN`/`Infinity`. Same reason as `numberList`'s filter, and `0` is the honest
 *  reading of "not reported". */
const count = () =>
  v.fallback(
    v.pipe(
      v.number(),
      v.check((n: number) => Number.isFinite(n)),
      v.transform((n) => Math.trunc(n)),
    ),
    0,
  );

/** A count, or `null` where the sender said it could not tell — which is information a `0` would
 *  erase ("nobody is waiting" and "the broker would not say" are different readings). */
const countOrNull = () =>
  v.fallback(
    v.nullable(
      v.pipe(
        v.number(),
        v.check((n: number) => Number.isFinite(n) && n >= 0),
        v.transform((n) => Math.trunc(n)),
      ),
    ),
    null,
  );

/**
 * A real boolean, never merely truthy: anything else falls back to `false` (the unqualified
 * reading).
 */
const isTrue = () => v.fallback(v.boolean(), false);

/** One of a closed set, or the stated fallback. */
const oneOf = <T extends string>(options: readonly T[], fallback: T) =>
  v.fallback(v.picklist(options), fallback);

/**
 * One of a closed set, or `null`; an unknown value reads as nothing rather than as the wrong
 * something.
 */
const oneOfOrNull = <T extends string>(options: readonly T[]) =>
  v.fallback(v.nullable(v.picklist(options)), null);

/** The members of a closed set, dropping the rest. The narrowing is per member for the reason
 *  `checks_run` gives: an unknown entry would reach a renderer as a check that ran. */
const listOf = <T extends string>(options: readonly T[]) =>
  v.fallback(
    v.pipe(
      v.array(v.unknown()),
      v.transform((entries) =>
        entries.filter((x): x is T => (options as readonly unknown[]).includes(x)),
      ),
    ),
    [] as T[],
  );

/** Any object, untouched. The backend types this as a bare `dict[str, object]`, so there is
 *  nothing here to validate and pretending otherwise would drop keys a surface reads. */
const jobSummary = () =>
  v.fallback(
    v.custom<JobSummary>((x) => typeof x === 'object' && x !== null),
    {} as JobSummary,
  );

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

/** Which verifier can have produced a confidence. See `AnswerEvent.verified_by`. */
const VERIFIED_BY = ['judge', 'citation-gate'] as const;

/* ── the members ─────────────────────────────────────────────────────────── */

/**
 * A place in a session's line: a non-negative integer, or `null` (anything else reads as no place).
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

const queuedEvent = v.object({
  type: v.literal('queued'),
  /*
   * Two waits share this event, told apart by `ticket`: `null` is the admission wait (no permit
   * free; the first event of the turn), set is a place in a shared session's line (repeats as the
   * place changes). `ticket` is what `DELETE /sessions/{id}/queue/{ticket}` takes.
   */
  ticket: placeOrNull(),
  /** How many messages are ahead of this one: `0` is next, waiting only for the running turn. */
  position: placeOrNull(),
});
export type QueuedEvent = v.InferOutput<typeof queuedEvent>;

const planEvent = v.object({
  type: v.literal('plan'),
  /** The harness's current todo list. Emitted only when the list CHANGED, so each one is a
   *  genuine revision rather than a repeat. Absent entirely unless harness mode is on. */
  todos: textList(),
  /**
   * The identity of this plan, required by `POST /sessions/{id}/plan/decision`, so the decision
   * binds to what was rendered. Empty (older service) means fetch the plan, never a hash that will
   * match.
   */
  plan_hash: text(),
  /**
   * The state-changing tools this plan's steps declare — what approving it authorizes. Empty (older
   * service) means fetch it, not "authorizes nothing".
   */
  scope: textList(),
});
export type PlanEvent = v.InferOutput<typeof planEvent>;

const toolCallEvent = v.object({
  type: v.literal('tool_call'),
  tool: text('unknown'),
  /** A RAW string truncated to 200 chars by the backend — NOT parsed JSON, and possibly cut
   *  mid-token. Never `JSON.parse` this unguarded. */
  arguments: text(),
  /**
   * The specialist that raised this event; empty means the main agent. Not carried by turn-level
   * events (`queued`, `capability_degraded`). Absent and `''` read the same, so a falsy check is
   * the whole handling.
   */
  agent: text(),
});
export type ToolCallEvent = Loosen<v.InferOutput<typeof toolCallEvent>, 'agent'>;

const tokenEvent = v.object({
  type: v.literal('token'),
  text: text(),
  /**
   * The agent that produced this chunk; empty means the main agent. Only unattributed chunks are
   * part of the answer.
   */
  agent: text(),
});
export type TokenEvent = Loosen<v.InferOutput<typeof tokenEvent>, 'agent'>;

const jobStartedEvent = v.object({
  type: v.literal('job_started'),
  job_id: text(),
  /** "calc" | "report" | "campaign" | "job" — lets a surface label the job without parsing the id. */
  kind: text('job'),
  /** The plan step this job was launched for (the todo's text); empty outside the harness. */
  plan_step: text(),
});
export type JobStartedEvent = Loosen<v.InferOutput<typeof jobStartedEvent>, 'plan_step'>;

const toolQueuedEvent = v.object({
  type: v.literal('tool_queued'),
  /** The tool whose open `tool_call` row this annotates — matched like a result, oldest open row
   *  for the same tool first, because nothing on the wire carries a call id. */
  tool: text('unknown'),
  /** The queued run's id; the same id a `job_started` carries if the wait outlasts the turn's. */
  job_id: text(),
  /**
   * `queued` while waiting for a compute slot, `running` once picked up. Unknown reads as `queued`.
   */
  state: oneOf(['queued', 'running'] as const, 'queued'),
  /** Approximate broker backlog for the connector's queue, or `null`. */
  waiting: countOrNull(),
});
export type ToolQueuedEvent = Loosen<v.InferOutput<typeof toolQueuedEvent>, 'waiting'>;

/** The one structured chemistry payload the backend produces. The backend types it as a bare
 *  `dict[str, object]`, so every key is unverified — treat all of them as optional. */
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

const jobCompletedEvent = v.object({
  type: v.literal('job_completed'),
  job_id: text(),
  summary: jobSummary(),
});
export type JobCompletedEvent = v.InferOutput<typeof jobCompletedEvent>;

const jobFailedEvent = v.object({
  type: v.literal('job_failed'),
  job_id: text(),
  /** Why it died, in the service's own words. May be empty — a job can fail without the
   *  workflow having anything printable to say about it, and "" must still read as a failure. */
  reason: text(),
});
export type JobFailedEvent = v.InferOutput<typeof jobFailedEvent>;

/**
 * The two terminal states of a durable job, on the turn stream or `GET /sessions/{id}/events`.
 * Consume both, or a failure looks like a running job.
 */
export type JobTerminalEvent = JobCompletedEvent | JobFailedEvent;

/**
 * A workflow has stopped and is waiting for an answer only a person can give. Not a `question`
 * (mid-turn): it is durable, has a deadline, is answered via `POST /pending/{id}/answer`, and may
 * be for someone else.
 *
 * `state` distinguishes the pushes: open and reminders carry `kind`, `asked_of`, `due_at` with
 * `waiting`; expiry carries `subject` and `reminders` with `expired`. An empty field means "this
 * push does not carry it". The matching `job_started` of `kind: 'awaiting'` shares `request_id`.
 */
const awaitingAnswerEvent = v.object({
  type: v.literal('awaiting_answer'),
  /** What `GET /pending` and `POST /pending/{id}/answer` are keyed by. The only field that is
   *  always populated, and the only one worth branching on. */
  request_id: text(),
  /**
   * `'waiting'` (open, reminders) or `'expired'`. Left as a string because the backend types it as
   * one.
   */
  state: text('waiting'),
  /** What is being decided, in one line. Sent on the **expiry** push. */
  subject: text(),
  /** The category of request ('measurement', 'approval', …). Sent on the **open** push. */
  kind: text(),
  /** Who was asked — a person or role. Never a reason to hide the event from others. */
  asked_of: text(),
  /** The deadline, ISO-8601. Sent on the open push. Empty means this push did not carry one, so a
   *  surface must render "no deadline shown" rather than "no deadline". */
  due_at: text(),
  /** How many reminders had been sent when this push was written. `0` on the open. */
  reminders: count(),
});
export type AwaitingAnswerEvent = v.InferOutput<typeof awaitingAnswerEvent>;

const questionEvent = v.object({
  type: v.literal('question'),
  question: text(),
  /** Concrete choices when the agent can enumerate them, so a surface can render buttons
   *  instead of free text. Often empty. */
  options: textList(),
});
export type QuestionEvent = v.InferOutput<typeof questionEvent>;

/**
 * A note was written into the knowledge graph. The service now sends `note_recorded`; this reader
 * also accepts the old `note_proposed` until every deployment has rolled forward (`ISSUES.md` Issue
 * 13, `RETAINED_FOR_ROLLOUT` in `tests/backendContract.test.ts`). Internally the member is still
 * `note_proposed`; that rename is a later step.
 */
const noteProposedEvent = v.object({
  type: v.literal('note_proposed'),
  note_id: text(),
  /** A reference the note was written under. */
  reference: text(),
});
export type NoteProposedEvent = v.InferOutput<typeof noteProposedEvent>;

const approvalRequestEvent = v.object({
  type: v.literal('approval_request'),
  prompt: text('Approval requested.'),
  /**
   * Always `""`: the hold mechanism it named was deleted upstream. Plan approvals are answered on
   * `POST /sessions/{id}/plan/decision`, bound by the `plan` event's hash.
   */
  approval_id: text(),
});
export type ApprovalRequestEvent = v.InferOutput<typeof approvalRequestEvent>;

/** An answer check the core layer can run. Mirrors `agent/verifier.AnswerCheck`. */
export type AnswerCheck = 'verifier' | 'answer-shape';

/** Every member of `AnswerCheck`, because the schema narrows `checks_run` against a list rather
 *  than a chain of comparisons: a third check is mirrored by adding it here, once. */
const ANSWER_CHECKS: readonly AnswerCheck[] = ['verifier', 'answer-shape'];

const answerEvent = v.object({
  type: v.literal('answer'),
  /**
   * The full assembled answer — the concatenation of every `token.text`. The store keeps
   * `streamedText` and `finalText` apart and renders one; never both.
   */
  text: text(),
  /** Verifier citation-faithfulness score in [0,1]. `null` unless the verifier is enabled. */
  confidence: v.fallback(v.nullable(v.number()), null),
  unsupported_claims: textList(),
  /** True when `confidence < verifier_confidence_threshold`: the "needs expert review" signal. */
  review_required: isTrue(),
  /**
   * Which answer checks ran on this turn; empty means none did. Both gates ship off upstream, and
   * an unchecked answer looks identical to a clean one otherwise, so render an empty array as
   * unverified, not clean.
   */
  checks_run: listOf(ANSWER_CHECKS),
  /**
   * Whether a second pass challenged this answer, and the hold it opened. Both are at their
   * defaults upstream today; mirrored so they are not dropped when revived.
   */
  challenged: isTrue(),
  /** The hold id when `challenged`, `null` otherwise. See `challenged`. */
  review_hold_id: v.fallback(v.nullable(v.string()), null),
  /**
   * Which verifier produced `confidence` (`citation-gate` is deterministic, `judge` is an LLM), or
   * `null`. The same number means different things per verifier.
   */
  verified_by: oneOfOrNull(VERIFIED_BY),
});
export type AnswerEvent = v.InferOutput<typeof answerEvent>;

/**
 * The closed set of reasons a turn ends badly (the backend's `ErrorCode`). A union so the compiler
 * flags a new code; `normalizeEvent` maps an unknown code to `internal`.
 */
export type ErrorCode =
  | 'internal'
  | 'storage_unavailable'
  | 'llm_timeout'
  | 'turn_timeout'
  | 'budget_exhausted'
  /**
   * Admission control shed the turn before it ran: "busy, retry" (`retryable: true`), unlike
   * `budget_exhausted`.
   */
  | 'at_capacity'
  | 'loop_cap_reached'
  | 'spend_cap_reached'
  | 'bad_tool_arguments'
  /**
   * The conversation no longer fits the model's context window. Never retryable as-is; the remedy
   * is a fresh session or a narrower question.
   */
  | 'context_length'
  /**
   * The model gateway refused the service's own credential (401/403). An operator must fix the key;
   * never retryable.
   */
  | 'llm_auth'
  /**
   * A queued message never ran (withdrawn, sender removed, session deleted). Nothing failed; do not
   * render it as a failed turn.
   */
  | 'queue_cancelled'
  /**
   * This view of the turn fell a full buffer behind and was cut off; the turn runs on. Reattach via
   * `GET /sessions/{id}/turn/stream` or read the transcript.
   */
  | 'stream_lagged'
  | 'empty_answer';

/** Every member of `ErrorCode`. An array rather than a `Set` because the schema picks from it and
 *  needs the literal types; `tests/eventContract.test.ts` holds it against the union beside it. */
const ERROR_CODES: readonly ErrorCode[] = [
  'internal',
  'storage_unavailable',
  'llm_timeout',
  'turn_timeout',
  'budget_exhausted',
  'at_capacity',
  'loop_cap_reached',
  'spend_cap_reached',
  'bad_tool_arguments',
  'context_length',
  'llm_auth',
  'queue_cancelled',
  'stream_lagged',
  'empty_answer',
];

const errorEvent = v.object({
  type: v.literal('error'),
  /** Safe to show the user — the backend never puts stack traces here. Also how a turn that
   *  blew the wall-clock limit is reported: as a final SSE event, not an HTTP error. */
  message: text('The turn failed.'),
  /** What kind of failure, so the surface can say something better than "the turn failed" and
   *  can lock the composer on a `budget_exhausted` that arrived as an event rather than a 429. */
  code: oneOf(ERROR_CODES, 'internal'),
  /** The backend's own judgement on whether sending the same turn again is worth doing. Not
   *  derivable from `code`: a `storage_unavailable` may or may not be, and it knows which. */
  retryable: isTrue(),
  /** Joins this failure to the audit trail and the server logs of the turn that produced it —
   *  the one thing a support conversation actually needs, and the one the user cannot look up. */
  correlation_id: text(),
});
export type ErrorEvent = v.InferOutput<typeof errorEvent>;

const capabilityDegradedEvent = v.object({
  type: v.literal('capability_degraded'),
  /**
   * Connectors that did not come up for this turn, so their tools were absent. Sent before the
   * first token; the turn continues.
   */
  connectors: textList(),
});
export type CapabilityDegradedEvent = v.InferOutput<typeof capabilityDegradedEvent>;

/**
 * Deliberate refusal kinds a `tool_failed` can carry (the backend's `RefusalReason`).
 * `src/lib/refusals.ts` turns them into copy; nothing else should switch on the raw string.
 */
export type RefusalReason = 'dry_run' | 'undeclared_write' | 'plan_gate' | 'repeat' | 'authz';

/** Every member of `RefusalReason`, for the normalizer and for exhaustiveness checks. */
export const REFUSAL_REASONS: readonly RefusalReason[] = [
  'dry_run',
  'undeclared_write',
  'plan_gate',
  'repeat',
  'authz',
];

const toolFailedEvent = v.object({
  type: v.literal('tool_failed'),
  /** One tool call raised; the turn continues. Distinct from `error`, which ends it: the model
   *  can route around a failed call, and when it cannot, this is the only event that says why. */
  tool: text('unknown'),
  message: text('The tool call failed.'),
  /**
   * What kind of deliberate refusal this is, or `null` for an ordinary failure. A refusal is the
   * control working and must not render as a fault.
   */
  reason: oneOfOrNull(REFUSAL_REASONS),
  /**
   * The specialist that raised this event; empty means the main agent (see `ToolCallEvent.agent`).
   */
  agent: text(),
  /**
   * The provider tool-call id of the failed call — the id its `exhibit_draft` frames carried — so
   * it drops its own draft (`failDraft`). Empty from older services.
   */
  call_id: text(),
});
export type ToolFailedEvent = Loosen<
  v.InferOutput<typeof toolFailedEvent>,
  'reason' | 'agent' | 'call_id'
>;

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

const toolResultEvent = v.object({
  type: v.literal('tool_result'),
  /** What a call returned, as data. Success only: a call that raised arrives as `tool_failed`. */
  tool: text('unknown'),
  /** Truncated by the backend exactly as `tool_call.arguments` is — a preview of the value, not
   *  the whole return. Raw; never `JSON.parse` it unguarded. */
  preview: text(),
  /**
   * The content address (SHA-256) of the untruncated result, fetchable at `GET
   * /sessions/{id}/tool-results/{ref}`. Empty means not stored, and is the only check for offering
   * "see the full result".
   */
  result_ref: text(),
  /**
   * The whole result when small enough to ride along (under `stream_inline_result_bytes`). An
   * optimisation only; `result_ref` is still the presence check.
   */
  result_inline: text(),
  /**
   * Whether the model was shown less than the tool returned. When set, `result_ref` opens the full
   * text (for the chemist), while `preview`, `note_ids`, `numbers` and `values` describe what the
   * model read. If the full text exceeded the store cap, the ref holds the cut, with its notice
   * in-band.
   */
  result_cut: isTrue(),
  /** Note ids the result cited, untruncated even when `preview` is not — so a citation survives
   *  the cut that loses the sentence around it. */
  note_ids: textList(),
  /** Numeric values the result carried, untruncated for the same reason. */
  numbers: numberList(),
  /**
   * The same figures under the tool's own keys, for display. Empty for non-JSON results (the
   * service will not guess names).
   */
  values: resultValues(),
  /**
   * The specialist that raised this event; empty means the main agent (see `ToolCallEvent.agent`).
   */
  agent: text(),
});
export type ToolResultEvent = Loosen<
  v.InferOutput<typeof toolResultEvent>,
  'result_inline' | 'result_cut' | 'values' | 'agent'
>;

const evidenceSourceEvent = v.object({
  type: v.literal('evidence_source'),
  /**
   * One retrieval source's report for a sweep, so a source that returned nothing is distinguishable
   * from one nobody asked.
   */
  source: text('unknown'),
  /** What the source found before the cross-source cap: "nothing to say" vs "crowded out". */
  chunks: count(),
  /**
   * Whether this source's retriever raised, rather than returning nothing. A broken source and a
   * silent one need different fixes.
   */
  failed: isTrue(),
});
export type EvidenceSourceEvent = Loosen<v.InferOutput<typeof evidenceSourceEvent>, 'failed'>;

const handoffEvent = v.object({
  type: v.literal('handoff'),
  /** The peer agent giving up control. Empty only if the backend could not name it. */
  from_agent: text(),
  /** The peer receiving control, and from here on the author of what the chemist reads. */
  to_agent: text(),
  /** The handing model's stated reason, for display only. */
  reason: text(),
});
export type HandoffEvent = v.InferOutput<typeof handoffEvent>;

/**
 * An artefact was created or revised — the header only; the body is fetched with `GET
 * /sessions/{id}/exhibits/{xid}?revision=N`. Emitted after `create_exhibit`/`revise_exhibit`, and
 * on the push-back stream for human revisions. It invalidates the list, may open the pane and puts
 * a card in the answer. Code name `exhibit` (see `shared/exhibits.ts`).
 */
const exhibitEvent = v.object({
  type: v.literal('exhibit'),
  /** `xb-` plus sixteen hex. What every artefact route is keyed by. */
  exhibit_id: text(),
  /** The revision this event announces — `1` on a create. */
  revision: count(),
  /** Open rather than narrowed, as `ExhibitHeader.kind` is: a card for a kind this build does not
   *  know still says that an artefact exists. */
  kind: text(),
  title: text(),
  /**
   * `created` or `revised`. Only `created` may open the pane, so an unknown value reads as
   * `revised`.
   */
  op: oneOf(['created', 'revised'] as const, 'revised'),
  /** Who wrote the revision. An unknown value reads as `agent`, which is the reading that captions
   *  a chart as transcribed rather than one that vouches for it. */
  author_kind: oneOf(['agent', 'human'] as const, 'agent'),
  /** The agent's name or the person's actor id, as the service records it. */
  author: text(),
  /**
   * The provider tool-call id that wrote this revision (as on that call's `exhibit_draft` frames),
   * so a draft is replaced by identity, not order (`src/state/exhibitDrafts.ts`). Empty for human
   * writes, reports and pushes.
   */
  call_id: text(),
});
export type ExhibitEvent = Loosen<v.InferOutput<typeof exhibitEvent>, 'call_id'>;

/**
 * A document artefact while the model is still writing it. Turn stream only: never persisted or in
 * the transcript. `markdown` is the whole text so far, not a delta, so a dropped frame costs
 * nothing. Replaced by the next matching `exhibit` frame, or discarded when the turn ends without
 * one (`src/state/exhibitDrafts.ts`).
 */
const exhibitDraftEvent = v.object({
  type: v.literal('exhibit_draft'),
  /** The provider's tool-call id — what tells two drafts in one turn apart. */
  call_id: text(),
  /** `create` or `revise`; unknown reads as `revise` (only a create may open the pane). */
  op: oneOf(['create', 'revise'] as const, 'revise'),
  /** Empty on a create (the service mints the id when the tool runs); the artefact on a revise. */
  exhibit_id: text(),
  /** `document`, or empty while the partial spec has not said yet. Open, as every kind field is. */
  kind: text(),
  title: text(),
  /** The Markdown written so far — the whole of it. Rendered, never edited. */
  markdown: text(),
  /** Whether the service has seen the end of the call's arguments. Nothing waits on it: the
   *  `exhibit` frame is the end that matters, and a call that ends refused never sends one. */
  done: isTrue(),
});
export type ExhibitDraftEvent = v.InferOutput<typeof exhibitDraftEvent>;

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
  | NoteProposedEvent
  | ApprovalRequestEvent
  | AnswerEvent
  | ErrorEvent;

export type ChemclawEventType = ChemclawEvent['type'];

/**
 * Every member, in union order — the one place membership is written. `v.variant` dispatches on
 * `type`, so this list is the gate and cannot drift from the decoder.
 */
const EVENT_MEMBERS = [
  queuedEvent,
  planEvent,
  toolCallEvent,
  tokenEvent,
  jobStartedEvent,
  toolQueuedEvent,
  jobCompletedEvent,
  jobFailedEvent,
  awaitingAnswerEvent,
  capabilityDegradedEvent,
  toolFailedEvent,
  toolResultEvent,
  evidenceSourceEvent,
  handoffEvent,
  exhibitEvent,
  exhibitDraftEvent,
  questionEvent,
  noteProposedEvent,
  approvalRequestEvent,
  answerEvent,
  errorEvent,
] as const;

/**
 * Second wire spellings of members already declared, resolved before dispatch. A rename in flight
 * is a decision with a deadline; adding an entry also needs `RETAINED_FOR_ROLLOUT` and the pinned
 * list in `tests/eventContract.test.ts`.
 */
const WIRE_ALIASES: Readonly<Record<string, string>> = { note_recorded: 'note_proposed' };

/** The decoder. One `v.variant` over the members above, dispatching on the discriminator. */
const eventSchema = v.variant('type', EVENT_MEMBERS);

/** Every wire name this client admits, derived from the schemas. Exported for tests. */
export const EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  ...EVENT_MEMBERS.map((member) => member.entries.type.literal),
  ...Object.keys(WIRE_ALIASES),
]);

/**
 * What each member carries (`discriminator -> field names`, excluding `type`). Exported for the
 * contract tests.
 */
export const EVENT_FIELDS: ReadonlyMap<string, readonly string[]> = new Map(
  EVENT_MEMBERS.map((member) => [
    member.entries.type.literal,
    Object.keys(member.entries).filter((key) => key !== 'type'),
  ]),
);

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
  return parsed.success ? parsed.output : null;
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
