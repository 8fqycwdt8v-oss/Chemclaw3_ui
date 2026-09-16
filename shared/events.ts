/**
 * The Chemclaw turn-event contract — a mirror of `service/events.py` in the backend repo.
 *
 * The backend streams these as Server-Sent Events, serialising each with `model_dump_json()`
 * and setting BOTH the SSE `event:` name and the JSON `type` field to the same discriminator.
 * We prefer the JSON field and fall back to the SSE name.
 *
 * Verified against 8fqycwdt8v-oss/Chemclaw3 (src/chemclaw/api/events.py). Eighteen members —
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
 * Then it said fifteen, and it was two short: `evidence_source` (backend M10) and `handoff`
 * (backend M9) had both shipped without reaching this file. Same rule, fifth and sixth time. The
 * pattern behind all six is worth naming, because it is not carelessness: this file mirrors a
 * contract that lives in another repository, and nothing mechanical connects them — the backend
 * can add a member and stay green, and so can this. Until something checks the two against each
 * other, the only defence is that a backend change is not finished until it lands here.

 *
 * Then it happened three more times on FIELDS rather than members, which the count above cannot
 * catch at all: `plan.plan_hash`, `tool_failed.reason` and `evidence_source.failed` were each added
 * upstream with an explicit note that this shape "is a contract two other repositories read", and
 * none of them arrived. Each was dropped silently by `normalizeEvent`, which rebuilds every event
 * field by field — so an unmirrored field is not merely untyped here, it is deleted in transit. The
 * cost was the specific thing each was added for: a plan answerable only after a second round trip
 * that races it, a correctly-gated refusal rendered as a fault, and a broken retriever rendered as
 * an empty one. `tests/eventContract.test.ts` now drives a fixture of every member carrying every
 * field through `normalizeEvent` and asserts nothing is lost, which is the closest thing to a
 * mechanical connection this side can have on its own.
 *
 * The same release added a field rather than a member: `agent` on `tool_call`, `tool_failed` and
 * `tool_result`, naming the specialist that raised the event. Empty means the main agent, so it is
 * additive by construction and an existing reader is unaffected.
 *
 * Then two more fields on `tool_result`, and this time the tripwire on the other side fired first:
 * `values` (the figures under the keys the tool filed them under) and `result_inline` (the whole
 * result when it is small enough to ride along). Both are additive with empty defaults, both are
 * mirrored in the interface AND in `normalizeEvent` below — which is the half that matters, since
 * this normaliser rebuilds every event field by field and an unmirrored field is *deleted in
 * transit* rather than merely untyped.
 *
 * The eighteenth member arrived the way the rule above says one should: the backend's own contract
 * tripwire fired inside the change that added it, and named this file and this normaliser in its
 * failure message. `awaiting_answer` (backend D-2026-09-05) is the notification that a workflow has
 * stopped and is waiting for a person. The row behind it had been written on every open, reminder
 * and expiry since the workflow was built and claimed by nothing, so it aged out undelivered —
 * which is the *sixth* form of the same failure this file keeps recording, one repository further
 * upstream: a producer with no consumer instead of a member with no mirror.
 *
 * **And then there were seventeen, because one of them was deleted.** `handoff` is the same seam
 * failing in the direction the paragraphs above never consider: not a member missing from this
 * mirror, but a member of this mirror that nothing upstream can send. The specialist team that
 * raised it was deleted, and the event model outlived its producer — measured rather than assumed,
 * a grep over the service finds the class and its union membership and nothing anywhere that
 * constructs one. That failure is not silent the way the six above were; it is a consumer chain
 * that reads as a live feature, and this repo carried the whole of one: the member, the branch in
 * `normalizeEvent`, a `TraceKind`, a step counted in the turn summary, and a "Handed to X" row in
 * the trace panel, none of which could ever render. It is gone, and
 * `tests/eventContract.test.ts` pins the absence — so mirroring it again means bringing the
 * producer with it. (The count in the paragraph above is left as it was written: it was true of
 * the commit that wrote it, and renumbering prose every time the union moves is how the numbers in
 * it stop being checkable at all.)
 *
 * ## This file used to say "keep it dependency-free", and now takes one
 *
 * It is imported by the SPA (bundled by Vite), by the mock backend (bundled by esbuild) and by the
 * e2e fixture service (run under `node --experimental-strip-types`). All three resolve an ordinary
 * npm dependency, so that rule was policy rather than physics — and the policy has now been
 * reversed deliberately, on the record, for `valibot` and for nothing else. See
 * `docs/dependencies.md`.
 *
 * **The reason is the changelog above.** Six members and three fields shipped upstream and were
 * *deleted in transit*, because `normalizeEvent` rebuilt every event field by field: a field this
 * mirror did not know about was not merely untyped, it was silently dropped, and a well-formed
 * event arrived with its qualifying half removed. Every one of those was a hand-written switch
 * branch failing to keep up with a hand-written interface beside it.
 *
 * So the interface is no longer hand-written. Each member is a `valibot` schema and its exported
 * type is `v.InferOutput` of that schema, which makes the two the same object: **a field cannot
 * exist in the type and be absent from the decoder**, because there is nowhere for it to exist. The
 * class of defect this file has recorded nine times is now unrepresentable rather than tested for.
 *
 * What it costs, stated because it is a real loss in a file whose value is its prose: a field's
 * documentation now sits above its schema entry instead of above an interface member, so an editor
 * hovering `event.plan_hash` no longer shows it. The prose is in the same place in the file, one
 * construct over, and that is the trade.
 *
 * **`valibot` rather than `zod`**: this surface tree-shakes to ~2-4 kB gz where zod classic is
 * ~13 kB, and `shared/` is bundled into the SPA. `src/env.ts` declines a schema library for the
 * runtime config and that decision stands — a dozen string checks over a handful of keys is not a
 * 17-member discriminated union with per-field defaults, and the argument there ("more bytes than
 * the rest of this module") is about a module this one is fifty times the size of.
 */

import * as v from 'valibot';

/**
 * Make some keys optional to *write* while leaving them present to read.
 *
 * Five fields on this wire are documented as "optional in the type, always populated by
 * `normalizeEvent`", and the argument is theirs rather than this helper's: the backend defaults
 * each one precisely so an existing consumer is unaffected, and a required mirror makes every
 * construction site — every test, every fixture, the mock, the e2e fixture service — name a field
 * that means "nothing". Measured: making the five required breaks 78 call sites.
 *
 * A schema cannot express that on its own — `v.optional(s, d)` produces a *required* output key,
 * which is the correct reading for a consumer and the wrong one for a writer. So the relaxation is
 * named here, per field, at the type alias. It is the only hand-written part of any event's shape,
 * and it can only ever remove a `?`, never add or drop a field.
 */
type Loosen<T, K extends keyof T> = Omit<T, K> & { [P in K]?: T[P] };

/* ── the coercion vocabulary ─────────────────────────────────────────────────
 *
 * Eight helpers, one per shape this wire actually carries, replacing the six hand-written coercers
 * this file used to run inside a 130-line switch. Each is a `v.fallback`, so a malformed field
 * costs that field and never the event: these values cross a process boundary, and a frame a
 * service got wrong must not take a conversation with it.
 */

/** A string, or the stated fallback. The shape most of this wire has. */
const text = (fallback = '') => v.fallback(v.string(), fallback);

/** Every entry stringified; a non-array is empty. The wire's `[str]` fields, read exactly as they
 *  were — `['a', 1]` is `['a', '1']`, because one unexpected entry is not a reason to drop a list a
 *  surface is about to render. */
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

/** A real boolean, never merely truthy. A `1` or a `'yes'` is a service getting it wrong, and
 *  every flag on this wire qualifies an answer — so the safe reading is the unqualified one. This
 *  is `o.field === true` written once: anything that is not a boolean falls back to `false`. */
const isTrue = () => v.fallback(v.boolean(), false);

/** One of a closed set, or the stated fallback. */
const oneOf = <T extends string>(options: readonly T[], fallback: T) =>
  v.fallback(v.picklist(options), fallback);

/** One of a closed set, or `null` — for a field whose absence is itself the information. An
 *  unrecognised value normalises to `null` rather than passing through, because "a value this
 *  build does not know" must read as nothing, never as the wrong something. */
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

/**
 * The labelled figures, dropping anything that is not one.
 *
 * A value with no label is not usable by the surfaces this field exists for — it is exactly the
 * unnamed number `numbers` already carries — and a non-finite one is a blank cell nobody can
 * explain, which is the same rule `numberList` takes one field up.
 */
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

const queuedEvent = v.object({
  type: v.literal('queued'),
  /* No payload. The backend emits this only when the turn actually had to wait for an admission
   * permit, and it is then the FIRST event of that turn. A turn that gets a permit immediately —
   * the normal case — never sends one, so seeing it at all is the information. */
});
export type QueuedEvent = v.InferOutput<typeof queuedEvent>;

const planEvent = v.object({
  type: v.literal('plan'),
  /** The harness's current todo list. Emitted only when the list CHANGED, so each one is a
   *  genuine revision rather than a repeat. Absent entirely unless harness mode is on. */
  todos: textList(),
  /**
   * The identity of THIS plan, which is what `POST /sessions/{id}/plan/decision` requires.
   *
   * Without it the event cannot be acted on: answering the plan just rendered meant a second
   * `GET /sessions/{id}/plan` round trip, which races the very change the hash exists to catch —
   * between the render and the fetch the agent may revise the plan, and the client would post back
   * a hash for a plan its user never saw.
   *
   * Empty means "this event predates the field", which a consumer must treat as "go and fetch it",
   * never as a hash that will match. The backend defaults it for exactly that reason, so an older
   * service degrades to the round trip rather than to a wrong answer.
   */
  plan_hash: text(),
});
export type PlanEvent = v.InferOutput<typeof planEvent>;

const toolCallEvent = v.object({
  type: v.literal('tool_call'),
  tool: text('unknown'),
  /** A RAW string truncated to 200 chars by the backend — NOT parsed JSON, and possibly cut
   *  mid-token. Never `JSON.parse` this unguarded. */
  arguments: text(),
  /** The specialist that raised this event; **empty means the main agent**, which is what every
   *  event meant before teams existed — so ignoring this field reads exactly as before. Carried
   *  only by the events a specialist can actually raise: a `queued` or `capability_degraded` is a
   *  property of the turn, decided before any routing, so attributing it would invent a fact.
   *
   *  Optional in the type, always populated by `normalizeEvent`. Required would contradict the
   *  claim the field is built on: the backend defaults it to `''` precisely so an existing
   *  consumer is unaffected, and a required mirror makes every construction site — every test,
   *  every fixture, the mock — name a field that means "no specialist". Absent and `''` both read
   *  as the main agent, so a falsy check is the whole handling. */
  agent: text(),
});
export type ToolCallEvent = Loosen<v.InferOutput<typeof toolCallEvent>, 'agent'>;

const tokenEvent = v.object({
  type: v.literal('token'),
  text: text(),
  /** The agent that produced this chunk; **empty means the main agent**. The backend emits it on
   *  every token (`agent="subagent" if namespace else ""`) and its own docstring says a consumer
   *  "concatenates only the unattributed ones", because an attributed chunk is another agent's
   *  working notes rather than part of the answer. Same optionality rule as `ToolCallEvent.agent`:
   *  optional in the type, always populated by `normalizeEvent`, and a falsy check is the whole
   *  handling. */
  agent: text(),
});
export type TokenEvent = Loosen<v.InferOutput<typeof tokenEvent>, 'agent'>;

const jobStartedEvent = v.object({
  type: v.literal('job_started'),
  job_id: text(),
  /** "calc" | "report" | "campaign" | "job" — lets a surface label the job without parsing the id. */
  kind: text('job'),
  /** The plan step this job was launched for — the todo's bare text, so the checklist item can be
   *  matched without sharing a hash function with the service (backend D-2026-08-27). Empty means
   *  the job was not launched from a plan step, which is every job outside the harness. Same
   *  optionality rule as `TokenEvent.agent`: optional in the type, always populated by
   *  `normalizeEvent`, and a falsy check is the whole handling. */
  plan_step: text(),
});
export type JobStartedEvent = Loosen<v.InferOutput<typeof jobStartedEvent>, 'plan_step'>;

/** The one structured chemistry payload the backend produces. The backend types it as a bare
 *  `dict[str, object]`, so every key is unverified — treat all of them as optional. */
export interface JobSummary {
  job_id?: string;
  molecule_smiles?: string;
  total_energy_hartree?: number;
  converged?: boolean;
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

/** The two terminal states of a durable job. Both arrive on the turn stream when the job finishes
 *  inside the turn, and on `GET /sessions/{id}/events` when it finishes after it. Anything that
 *  consumes one must consume the other, or a failure looks exactly like a job still running. */
export type JobTerminalEvent = JobCompletedEvent | JobFailedEvent;

/**
 * A workflow has stopped and is waiting for an answer only a person can give.
 *
 * **Not a `question`.** `QuestionEvent` is the agent asking mid-turn, with the turn held open and
 * the answer arriving as the next message. This one outlives its turn: the request is durable, it
 * has a deadline, it is answered through `POST /pending/{id}/answer`, and the person who has to
 * answer it may not be the person whose turn opened it. A surface that folds the two together
 * would put a days-long request in a chat bubble that scrolls away.
 *
 * **`state` is what tells the two pushes apart**, because the backend deliberately sends one event
 * type rather than two. The open — and every reminder — carries `kind`, `asked_of` and `due_at`
 * with `state: 'waiting'`; the expiry carries `subject` and `reminders` with `state: 'expired'`
 * and nothing else. Every field but `request_id` is therefore routinely empty, on one side or the
 * other, and an empty one is "this push does not carry it" rather than "this request has none".
 *
 * The `job_started` of `kind: 'awaiting'` recorded beside the wait names the same `request_id`.
 * That is the join: a surface that shows a wait as a running job can close it out on this event
 * instead of leaving it running until the tab is reloaded.
 */
const awaitingAnswerEvent = v.object({
  type: v.literal('awaiting_answer'),
  /** What `GET /pending` and `POST /pending/{id}/answer` are keyed by. The only field that is
   *  always populated, and the only one worth branching on. */
  request_id: text(),
  /** `'waiting'` on the open and on every reminder, `'expired'` when the deadline passed with no
   *  answer. Open upstream — a string, not a union — because the backend types it as a bare `str`
   *  defaulted to `'waiting'`, and narrowing it here would make a third state this build does not
   *  know render as nothing at all. */
  state: text('waiting'),
  /** What is being decided, in one line. Sent on the **expiry** push. */
  subject: text(),
  /** The category of request ('measurement', 'approval', …). Sent on the **open** push. */
  kind: text(),
  /** Who was asked — a person or a role. Sent on the open push. Never a reason to hide the event
   *  from anyone else: the deadline is the whole point, and a request nobody can see is exactly
   *  the one that expires. */
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
 * A note was written into the knowledge graph.
 *
 * **The wire carries two names for this and the reader takes both.** The event is not a proposal:
 * nothing reviews a note any more (`D-2026-09-05-the-gate-follows-behaviour-not-knowledge`
 * upstream), so the accurate name is `note_recorded`. Renaming an SSE discriminator is a
 * two-repository deploy with a skew window, and the only ordering that has no broken state is
 * **reader first**: this client accepted both names, the service switched to the new one, and no
 * deployed frontend dropped an event in between. The reverse order — service first — silently
 * drops the event in every browser that has not been redeployed, which is the exact failure
 * `EVENT_TYPES` has cost six times.
 *
 * **The service has now shipped its half**, so `note_proposed` is the *old* name rather than the
 * current one: `src/chemclaw/api/events.py` declares `type: Literal["note_recorded"]` and no
 * longer declares the old spelling at all. This reader keeps it because every browser already
 * loaded speaks it; dropping it before that rollout is done is the same event loss with the
 * repositories swapped.
 *
 * `type` stays `'note_proposed'` inside this app on purpose: the internal name is a local rename
 * that can happen any day, and doing it in the same step would put a second change in the skew
 * window for no gain. Removing the old wire name is the third step, it is this repository's, and
 * it is recorded in `ISSUES.md` with what unblocks it. `tests/backendContract.test.ts` holds the
 * promise from the other end: `note_proposed` is in its `RETAINED_FOR_ROLLOUT` map with this
 * reason, an `ISSUES.md` row whose deletion expires the entry, and a date by which somebody
 * re-takes the decision.
 */
const noteProposedEvent = v.object({
  type: v.literal('note_proposed'),
  note_id: text(),
  /** The branch/PR reference the note was opened on, for the PR-gated knowledge graph. */
  reference: text(),
});
export type NoteProposedEvent = v.InferOutput<typeof noteProposedEvent>;

const approvalRequestEvent = v.object({
  type: v.literal('approval_request'),
  prompt: text('Approval requested.'),
  /**
   * **Always `""`**, and mirrored only because that is what says so.
   *
   * It once carried the handle of a durable interaction hold, answerable via
   * `POST /approvals/{id}/decision`. The service deleted that whole mechanism
   * (`D-2026-08-27-a-hold-nothing-can-open-is-not-a-hold`) because nothing could ever open one,
   * and its upstream model now documents this field as permanently empty: a non-empty value
   * would name a hold that cannot exist. Nothing in this app branches on it.
   *
   * A plan approval — the only shape this event has — is answered on
   * `POST /sessions/{id}/plan/decision` and bound by the hash on the `plan` event, never by this.
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
   * The FULL assembled answer — i.e. the concatenation of every preceding `token.text`.
   *
   * Rendering this *and* the accumulated tokens double-renders the whole answer. See
   * `src/state/chatStore.ts`: the store keeps `streamedText` and `finalText` apart and the
   * renderer picks one. There is deliberately no code path that concatenates them.
   */
  text: text(),
  /** Verifier citation-faithfulness score in [0,1]. `null` unless the verifier is enabled. */
  confidence: v.fallback(v.nullable(v.number()), null),
  unsupported_claims: textList(),
  /** True exactly when `confidence < verifier_confidence_threshold`. The routing signal for a
   *  "needs expert review" affordance. */
  review_required: isTrue(),
  /**
   * Which answer checks actually ran on this turn. **Empty means none did.**
   *
   * This is drift #12, and it is the one that makes the three fields above readable. Both honesty
   * gates ship *off* (`verifier_enabled`, `answer_shape_gate_enabled`), and measured on the core
   * side an ungated answer and a checked-and-clean one were **byte-identical on the wire**:
   * `confidence: null`, `review_required: false`, `unsupported_claims: []` either way. So a
   * surface that flags on `review_required` shows an unflagged answer in both cases, and cannot
   * tell "we looked and it was fine" from "nobody looked".
   *
   * `runner_answer.build_answer_event`'s docstring claimed every field was either what a check
   * found or the `null`/`false` that says the check did not run. That was true of the verifier
   * (`confidence`/`verified_by` are null) and false of the shape gate, which had no field of its
   * own — so this array is the shape gate's.
   *
   * A renderer should treat an empty array as *unverified*, not as *clean*. Anything else repeats
   * the ambiguity on the screen after the wire stopped carrying it.
   */
  checks_run: listOf(ANSWER_CHECKS),
  /**
   * Whether a second pass challenged this answer, and the durable hold that pass opened.
   *
   * **Both are on the wire and both were being deleted in transit.** `runner_answer.py` passes
   * `challenged=review.challenged, review_hold_id=review.hold_id` on *every* answer, and this
   * mirror carried neither — so `normalizeEvent`, which rebuilds each event field by field, dropped
   * them. That is drift #11 in the list this file keeps.
   *
   * They are both permanently at their defaults today (`agent/verifier.py` has assigned neither
   * since D-2026-08-15), so nothing renders differently for mirroring them. That is exactly why it
   * had to be done now rather than later: the backend's own comment says reviving them is a
   * coordinated three-repo cut, and the cut is precisely the change a hand-written mirror cannot
   * notice.
   */
  challenged: isTrue(),
  /** The hold id when `challenged`, `null` otherwise. See `challenged`. */
  review_hold_id: v.fallback(v.nullable(v.string()), null),
  /**
   * Which verifier produced `confidence`, or `null` when none ran.
   *
   * Worth carrying rather than collapsing, because the same number means different things:
   * `citation-gate` is deterministic and scores an answer against the turn's own tool results,
   * and `judge` is an LLM scoring it against the claims. A surface that shows one score for both
   * is averaging two different measurements.
   */
  verified_by: oneOfOrNull(VERIFIED_BY),
});
export type AnswerEvent = v.InferOutput<typeof answerEvent>;

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
  /**
   * Admission control shed this turn: the service had no permit free within its admission
   * timeout, so nothing ran at all.
   *
   * Its own member rather than `budget_exhausted`, because the two are opposite instructions —
   * this one is "we are busy, retry in a moment" (`retryable: true`) and that one is "the budget
   * is spent, stop retrying" (`retryable: false`). They shared a code until the service split
   * them, and this app is the surface that paid for it: `errorFromEvent` had to read `retryable`
   * to work out which of the two had arrived, on a taxonomy whose whole contract is that the code
   * says what to do next.
   */
  | 'at_capacity'
  | 'loop_cap_reached'
  | 'spend_cap_reached'
  | 'bad_tool_arguments'
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
  /** Connectors that did not come up for this turn, so their tools were absent from it. Emitted
   *  before the first token, so a surface can mark the answer as partial while it streams rather
   *  than retroactively. The turn is NOT failed by this — it costs tools, not the conversation. */
  connectors: textList(),
});
export type CapabilityDegradedEvent = v.InferOutput<typeof capabilityDegradedEvent>;

/**
 * The kinds of deliberate refusal a `tool_failed` can carry.
 *
 * Mirrors the backend's `core/turn_signals.RefusalReason`, which is the single definition its
 * classification table and its wire model both import. `src/lib/refusals.ts` is what turns one of
 * these into something a chemist can act on; nothing else in this app should switch on the raw
 * string.
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
   * What KIND of failure this is, where the kind is a decision somebody made rather than a fault.
   *
   * A refusal is the control working, and a surface that renders it beside a database outage
   * reports a correctly-gated turn as a broken one — the mistake the backend's own `evals/live.py`
   * made, by matching one phrase of the refusal sentence.
   *
   * **Five members, and this mirror said one for a release.** The backend's
   * `agent/audit.refusal_reason` has classified five gates since it was written, but only
   * `plan_gate` reached the wire — so a dry run the chemist themselves asked for, a role denial, a
   * write a narrowed agent was never given, and a repeat the guard stopped all arrived here
   * indistinguishable from an unreachable pod, and this UI rendered all four in the failure red.
   *
   * `null` is "an ordinary failure", which is every failure emitted before the field existed.
   */
  reason: oneOfOrNull(REFUSAL_REASONS),
  /** The specialist that raised this event; **empty means the main agent**, which is what every
   *  event meant before teams existed — so ignoring this field reads exactly as before. Carried
   *  only by the events a specialist can actually raise: a `queued` or `capability_degraded` is a
   *  property of the turn, decided before any routing, so attributing it would invent a fact.
   *
   *  Optional in the type, always populated by `normalizeEvent`. Required would contradict the
   *  claim the field is built on: the backend defaults it to `''` precisely so an existing
   *  consumer is unaffected, and a required mirror makes every construction site — every test,
   *  every fixture, the mock — name a field that means "no specialist". Absent and `''` both read
   *  as the main agent, so a falsy check is the whole handling. */
  agent: text(),
});
export type ToolFailedEvent = Loosen<v.InferOutput<typeof toolFailedEvent>, 'reason' | 'agent'>;

/**
 * One number a structured tool result returned, under the name the tool gave it.
 *
 * The service's own rule, mirrored because a consumer that softened it would undo the point: the
 * `label` is the payload's key path (`pka`, `limit.limits.0.value`) and nothing else, and `unit`
 * is only ever a `unit`/`units` string the payload put beside that number. Neither is prettified
 * and neither is inferred.
 *
 * So a surface may write `pKa 4.76` and, where the tool said so, `0.5 µg/day`. It may **not**
 * write `4.76 ± 1.6` from `[{pka: 4.76}, {sd: 1.6}]`: nothing on the wire says the second is an
 * uncertainty on the first, and inventing that relationship is the exact failure `numbers` and
 * this field exist on opposite sides of.
 */
export interface ResultValue {
  label: string;
  value: number;
  unit: string;
}

const toolResultEvent = v.object({
  type: v.literal('tool_result'),
  /** What a call returned, as data rather than as the model's paraphrase of it. Success only:
   *  a call that raised arrives as `tool_failed` instead, and the two are exhaustive — which is
   *  why there is no `ok` flag to check. */
  tool: text('unknown'),
  /** Truncated by the backend exactly as `tool_call.arguments` is — a preview of the value, not
   *  the whole return. Raw; never `JSON.parse` it unguarded. */
  preview: text(),
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
  result_ref: text(),
  /**
   * The whole result, when it was small enough to ride along instead of costing a fetch.
   *
   * The preview/ref split is a rule about *large* results, and applying it to a 300-byte ICH limit
   * bought a second round trip for a payload smaller than the preview's own budget. Under the
   * service's `stream_inline_result_bytes` this carries the text; over it, the field is empty and
   * the ref is the way to the result exactly as before — so a consumer treats this as an
   * optimisation and never as the presence check. `result_ref` is still what says a result is
   * stored.
   */
  result_inline: text(),
  /** Note ids the result cited, untruncated even when `preview` is not — so a citation survives
   *  the cut that loses the sentence around it. */
  note_ids: textList(),
  /** Numeric values the result carried, untruncated for the same reason. */
  numbers: numberList(),
  /**
   * The same figures, each under the key the tool filed it under — for a surface that *displays* a
   * value rather than checking one.
   *
   * Empty for a result that is not JSON, which is the honest report rather than a gap: the service
   * refuses to guess a name out of prose, so the figures arrive in `numbers` unnamed, which is
   * what they are. Optional in the type and always populated by `normalizeEvent`, on the same
   * grounds as `agent`: the service defaults it, so an older one simply sends nothing.
   */
  values: resultValues(),
  /** The specialist that raised this event; **empty means the main agent**, which is what every
   *  event meant before teams existed — so ignoring this field reads exactly as before. Carried
   *  only by the events a specialist can actually raise: a `queued` or `capability_degraded` is a
   *  property of the turn, decided before any routing, so attributing it would invent a fact.
   *
   *  Optional in the type, always populated by `normalizeEvent`. Required would contradict the
   *  claim the field is built on: the backend defaults it to `''` precisely so an existing
   *  consumer is unaffected, and a required mirror makes every construction site — every test,
   *  every fixture, the mock — name a field that means "no specialist". Absent and `''` both read
   *  as the main agent, so a falsy check is the whole handling. */
  agent: text(),
});
export type ToolResultEvent = Loosen<
  v.InferOutput<typeof toolResultEvent>,
  'result_inline' | 'values' | 'agent'
>;

const evidenceSourceEvent = v.object({
  type: v.literal('evidence_source'),
  /** One retrieval source's own report of what it contributed to a sweep, emitted while the sweep
   *  runs. `gather_evidence` asks every source at once and merges the results, and in the merged
   *  list a source that returned nothing is indistinguishable from a source nobody asked — which
   *  is a real defect the backend has already paid for once. */
  source: text('unknown'),
  /** What the source FOUND, before the cross-source cap. So "had nothing to say" and "was crowded
   *  out of the budget" stay distinguishable; they are different problems with different fixes. */
  chunks: count(),
  /**
   * Whether this source's retriever RAISED, rather than being asked and having nothing.
   *
   * The third case, and the one the other two collapse into without it: a branch that fails
   * degrades to an empty list, so it reports `chunks: 0` and reads exactly like a source that was
   * consulted and was silent. The remedies do not overlap — a dark source is a question about the
   * corpus, a broken one is a page for whoever owns the index.
   *
   * Optional in the type and always populated by `normalizeEvent`, for the same reason `agent` is:
   * the backend defaults it so an existing consumer is unaffected.
   */
  failed: isTrue(),
});
export type EvidenceSourceEvent = Loosen<v.InferOutput<typeof evidenceSourceEvent>, 'failed'>;

export type ChemclawEvent =
  | QueuedEvent
  | PlanEvent
  | ToolCallEvent
  | TokenEvent
  | JobStartedEvent
  | JobCompletedEvent
  | JobFailedEvent
  | AwaitingAnswerEvent
  | CapabilityDegradedEvent
  | ToolFailedEvent
  | ToolResultEvent
  | EvidenceSourceEvent
  | QuestionEvent
  | NoteProposedEvent
  | ApprovalRequestEvent
  | AnswerEvent
  | ErrorEvent;

export type ChemclawEventType = ChemclawEvent['type'];

/**
 * Every member, in the order the union declares them. The one place membership is written down.
 *
 * `v.variant` dispatches on `type`, so this array *is* the gate `EVENT_TYPES` used to be — and it
 * cannot drift from the decoder, because it is the decoder. That matters more here than anywhere
 * else in this file: the rule this header records as having cost six events is "`EVENT_TYPES` is
 * the gate, and an interface added to the union without its discriminator changes nothing at
 * runtime". There is no longer a second list for a discriminator to be missing from.
 */
const EVENT_MEMBERS = [
  queuedEvent,
  planEvent,
  toolCallEvent,
  tokenEvent,
  jobStartedEvent,
  jobCompletedEvent,
  jobFailedEvent,
  awaitingAnswerEvent,
  capabilityDegradedEvent,
  toolFailedEvent,
  toolResultEvent,
  evidenceSourceEvent,
  questionEvent,
  noteProposedEvent,
  approvalRequestEvent,
  answerEvent,
  errorEvent,
] as const;

/**
 * A second wire spelling of a member this union already declares.
 *
 * The one thing a `v.variant` cannot express, and it is deliberately a map rather than a
 * transforming member: a rename in flight across two repositories is a *decision with a deadline*,
 * and one line naming both spellings is what a reader and a `grep` can find. Adding a second entry
 * is an argument to make in `NoteProposedEvent`'s docstring, in
 * `tests/backendContract.test.ts`'s `RETAINED_FOR_ROLLOUT`, and in the pinned list in
 * `tests/eventContract.test.ts` — not a line in a set literal nobody has to explain.
 *
 * `note_recorded` is the name the service sends **today**; `note_proposed` is the member this app
 * still calls it internally. See `NoteProposedEvent` for why the internal rename is a separate
 * step and why the reader had to go first.
 */
const WIRE_ALIASES: Readonly<Record<string, string>> = { note_recorded: 'note_proposed' };

/** The decoder. One `v.variant` over the members above, dispatching on the discriminator. */
const eventSchema = v.variant('type', EVENT_MEMBERS);

/**
 * Every wire name this client admits — the gate, derived rather than transcribed.
 *
 * Exported because two test files need the list rather than a probe, and reading it off the
 * schemas is what makes it impossible for the gate to admit a name no member declares. That is the
 * defect the `handoff` mirror was: a consumer chain for an event nothing could send.
 */
export const EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  ...EVENT_MEMBERS.map((member) => member.entries.type.literal),
  ...Object.keys(WIRE_ALIASES),
]);

/**
 * What each member carries, as `discriminator -> field names`, excluding the discriminator itself.
 *
 * Exported for the contract tests, which used to answer this question by parsing this file with
 * the TypeScript compiler API — once to find the interfaces' properties, and once more to walk
 * every `o.<name>` inside `normalizeEvent`'s switch. Both existed because the declaration and the
 * decoder were different objects that could disagree. They are the same object now, so the
 * question has an answer at runtime and the two walks are gone.
 */
export const EVENT_FIELDS: ReadonlyMap<string, readonly string[]> = new Map(
  EVENT_MEMBERS.map((member) => [
    member.entries.type.literal,
    Object.keys(member.entries).filter((key) => key !== 'type'),
  ]),
);

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
  // Durable calculation jobs.
  'compute_reaction_energy',
  'compare_solvents',
  'scan_coordinate',
  'sample_conformers',
  'compute_interaction_energy',
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

/**
 * Coerce one decoded SSE frame into a `ChemclawEvent`, or `null` if it is not one we know.
 *
 * Returning `null` rather than throwing is deliberate: the backend's event union is explicitly
 * designed to grow ("adding an event is a new class here plus one branch in the runner and the
 * UI"), so an older frontend must ignore a newer event rather than break the turn.
 *
 * **The only way this returns `null` is an unrecognised discriminator.** Every field of every
 * member has a fallback, so a malformed field costs that field and never the event — which is the
 * same rule the hand-written coercers held, now stated once per shape instead of once per field.
 * A frame whose `type` names no member fails `v.variant`'s dispatch, which is exactly the gate
 * `EVENT_TYPES` used to be and is now the same object as the decoder.
 *
 * The discriminator may arrive on the payload or on the SSE `event:` line, and the payload wins —
 * see the header. A second wire spelling of a member is resolved through `WIRE_ALIASES` *before*
 * dispatch rather than by a transforming member, so the parsed event is the member itself and no
 * consumer has to learn the second name.
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
 * The backend's *default* cap (`CHEMCLAW_SERVICE_MAX_MESSAGE_CHARS`, default 100_000); over it is
 * a 422.
 *
 * A fallback, not the limit. The setting is tuned per deployment, so a build-time copy of it is
 * only right for a site that never changed it: raise it upstream and this refuses messages the
 * service would accept; lower it and the composer invites a message the service will reject after
 * the whole body has been sent. The live value reaches the SPA through `/config.js`
 * (`config.maxMessageChars`), and this is what stands in when nothing supplied one — an older BFF,
 * or a static preview with no server behind it.
 */
export const MAX_MESSAGE_CHARS = 100_000;

/**
 * Whether a configured cap is one anybody can serve — the *one* place that decision is taken.
 *
 * Both halves of `/config.js` need it and neither may disagree with the other: the BFF reads
 * `MAX_MESSAGE_CHARS` from the environment and refuses to boot on a value that is not a cap
 * (`server/config.ts`), and the SPA re-checks what crossed the bridge and keeps the default
 * instead (`src/env.ts`), because a browser has nowhere to refuse to. Two hand-written copies of
 * one predicate is how the first version of this went wrong in the opposite direction: the BFF
 * clamped a bad value up to `1` before the SPA's guard could see it, so `MAX_MESSAGE_CHARS=0`
 * shipped a one-character composer while the guard against exactly that stayed green.
 *
 * A positive integer, mirroring the backend's own `Field(default=100_000, gt=0)`. Zero is not
 * "unlimited" and a fraction is not a character count.
 */
export const isUsableMessageCap = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;
