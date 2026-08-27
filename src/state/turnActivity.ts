/**
 * What the turn is doing right now, and what it did once it is over.
 *
 * Two derivations, one file, because they are the same question asked in two tenses and a reader
 * comparing them has to be able to see that they agree.
 *
 * ## Why this is a function over the message rather than state on it
 *
 * Every fact here is already in the store: `queued` is a flag, the open tool call is the newest
 * `tool_call` row with no ending, the running job is an unsettled `job_started`, and the plan's
 * position is the `[x] `/`[ ] ` prefixes the service re-emits on every status flip. Storing a
 * derived "current activity" would be a second copy of all of it, kept in step by hand, wrong the
 * first time a branch forgot to update it. A pure function cannot drift, and it is testable
 * without rendering anything.
 *
 * ## The order of the checks is the design
 *
 * A turn can be several of these at once — a durable job runs asynchronously while the model keeps
 * talking — so "what is happening" needs a ranking rather than a set. It is:
 *
 *   queued → an open tool call → text arriving → an unsettled durable job → the plan → thinking
 *
 * with `queued` first because it is the one state where *nothing* is running (the turn has not
 * been admitted yet), and the open tool call above the tokens because a call that has not come
 * back is what the turn is actually blocked on. The durable job sits below the tokens on purpose:
 * it does not block the turn, so reporting it while the answer is being written would name the
 * slowest thing on screen rather than the thing the reader is watching.
 *
 * `planning` sits second from last and is worth its own state rather than being folded into
 * "thinking": a turn whose only event so far is a plan revision has done something specific and
 * visible, and a reader watching the row wants to know that the wait is the harness settling on a
 * plan rather than a model that has said nothing at all.
 */

import type { AssistantMessage, TraceEntry } from './types.ts';

/** Where the plan has got to, when the service told us. */
export interface PlanPosition {
  /** 1-based, over every step including the finished ones. */
  index: number;
  total: number;
  /** The step's own text, with the `[x] `/`[ ] ` prefix already off. */
  text: string;
}

export type ActivityKind = 'queued' | 'planning' | 'tool' | 'writing' | 'job' | 'thinking';

export interface TurnActivity {
  kind: ActivityKind;
  /** The sentence. One clause, present tense, no ellipsis of its own. */
  label: string;
  /** The identifier beside it — a tool name, a job id — or empty when there is none. */
  detail: string;
  /** The plan step this is happening under, when a plan is running. */
  step: PlanPosition | null;
  /**
   * Whether the wait is ours or somebody else's.
   *
   * `waiting` is the durable job and the admission queue: nothing this process does will make them
   * finish sooner, and the dot says so by not pulsing.
   */
  tone: 'busy' | 'waiting';
}

/**
 * The step the plan is on: the first one not marked done.
 *
 * `null` unless at least one line carries a status prefix. `GET /sessions/{id}/plan` returns bare
 * step text with no status, so a plan restored after a reload has no position to report — and
 * claiming "step 1 of 4" for it would be inventing a completion state nobody sent.
 */
export function planPosition(todos: readonly string[] | null): PlanPosition | null {
  if (!todos || todos.length === 0) return null;
  const statuses = todos.map((line) =>
    line.startsWith('[x] ') ? 'done' : line.startsWith('[ ] ') ? 'open' : 'plain',
  );
  if (!statuses.some((s) => s !== 'plain')) return null;
  const index = statuses.findIndex((s) => s === 'open');
  // Every step done: the plan is finished, so there is no current step to name.
  if (index === -1) return null;
  return { index: index + 1, total: todos.length, text: todos[index]!.slice(4) };
}

/** The newest tool call that has neither returned nor failed, i.e. the one still out. */
function openCall(trace: readonly TraceEntry[]): TraceEntry | undefined {
  return trace.findLast?.(
    (e) =>
      e.kind === 'tool_call' &&
      e.toolCall?.result === undefined &&
      !e.toolCall?.failed &&
      !e.toolCall?.unresolved,
  );
}

/** The newest durable job launched in this turn that has not reported an ending. */
function openJob(trace: readonly TraceEntry[]): TraceEntry | undefined {
  return trace.findLast?.((e) => e.kind === 'job_started' && !e.job?.settled);
}

/**
 * What this streaming turn is doing.
 *
 * Only meaningful while `status === 'streaming'`; a settled turn is described by
 * `summarizeTurn` instead.
 */
export function turnActivity(message: AssistantMessage): TurnActivity {
  const step = planPosition(message.latestPlan);
  const trace = message.trace;

  // Admission control, and only before anything else has happened: `queued` is a fact about how
  // the turn started and it is never retracted, so a turn that queued for two seconds and has
  // since called three tools is not "waiting for a slot".
  if (message.queued && trace.length === 0 && !message.streamedText) {
    return {
      kind: 'queued',
      label: 'Waiting for a free slot on the server',
      detail: '',
      step: null,
      tone: 'waiting',
    };
  }

  const call = openCall(trace);
  if (call?.toolCall) {
    return {
      kind: 'tool',
      label: step ? step.text : 'Calling a tool',
      detail: call.toolCall.tool,
      step,
      tone: 'busy',
    };
  }

  if (message.streamedText) {
    return { kind: 'writing', label: 'Writing the answer', detail: '', step, tone: 'busy' };
  }

  const job = openJob(trace);
  if (job?.job) {
    return {
      kind: 'job',
      // The step the launch served, when the service stamped one — that join is the whole point
      // of `job_started.plan_step`, and it is what turns "a job is running" into "step 3 is".
      label: job.job.planStep || step?.text || 'Running a durable job',
      detail: job.job.jobId,
      step,
      tone: 'waiting',
    };
  }

  // Nothing running, and the last thing that happened was the plan changing.
  if (trace.length > 0 && trace[trace.length - 1]!.kind === 'plan') {
    return { kind: 'planning', label: 'Reading the plan', detail: '', step, tone: 'busy' };
  }

  return { kind: 'thinking', label: 'Thinking', detail: '', step, tone: 'busy' };
}

/**
 * The one sentence a screen reader is told when the row changes.
 *
 * Transitions only, through the app's single polite region — the house rule in `state/announce.ts`
 * — because the alternative is a live region on a row that also carries a per-second timer, which
 * queues an announcement every second and reads the answer over the top of itself.
 */
export function describeActivity(activity: TurnActivity): string {
  const where = activity.step ? ` Step ${activity.step.index} of ${activity.step.total}.` : '';
  switch (activity.kind) {
    case 'queued':
      return 'Waiting for a free slot on the server.';
    case 'planning':
      return `Reading the plan.${where}`;
    case 'tool':
      return `Calling ${activity.detail}.${where}`;
    case 'writing':
      return 'Writing the answer.';
    case 'job':
      return `Waiting on a durable job.${where}`;
    default:
      return `Thinking.${where}`;
  }
}

/** What the turn turned out to be, once it has stopped. */
export interface TurnSummary {
  /** Rows a reader would count as steps — everything the rail renders. */
  steps: number;
  toolCalls: number;
  jobs: number;
  /** Failed calls and dead jobs: the rows worth opening the panel for. */
  problems: number;
  /**
   * Retrieval sources whose retriever RAISED during a sweep.
   *
   * Counted apart from `problems` because the remedies do not overlap: a broken index is a page
   * for whoever owns it, a failed tool call is usually the turn's own business. Naming them
   * separately in the panel's header is what lets a reader decide whether to open it at all.
   */
  sourcesDown: number;
  /**
   * Calls the plan gate refused.
   *
   * Counted apart from `problems`, and that separation is the same argument the trace panel makes
   * in colour: a refusal is the control working. Adding it to the failures would report a
   * correctly-gated turn as a broken one — the mistake the service's own live evaluation made
   * before `tool_failed.reason` existed.
   */
  held: number;
}

/** The events that are steps. `question` and `approval_request` are cards in the answer, not work. */
const STEP_KINDS = new Set([
  'plan',
  'tool_call',
  'tool_failed',
  'evidence_source',
  'job_started',
  'job_completed',
  'job_failed',
  'note_proposed',
  'handoff',
]);

/**
 * A run of consecutive `evidence_source` rows is one sweep.
 *
 * `gather_evidence` asks every source at once and reports each separately, so a five-source sweep
 * arrives as five events. Counting them as five steps would make one call look like most of the
 * turn — and the rail renders them as one row for exactly that reason, so the count has to agree
 * with what a reader can see.
 */
const isSweepContinuation = (entry: TraceEntry, previous: TraceEntry | undefined): boolean =>
  entry.kind === 'evidence_source' && previous?.kind === 'evidence_source';

export function summarizeTurn(trace: readonly TraceEntry[]): TurnSummary {
  let toolCalls = 0;
  let jobs = 0;
  let problems = 0;
  let sourcesDown = 0;
  let held = 0;
  let steps = 0;
  trace.forEach((entry, i) => {
    if (STEP_KINDS.has(entry.kind) && !isSweepContinuation(entry, trace[i - 1])) steps += 1;
    if (entry.kind === 'tool_call') toolCalls += 1;
    if (entry.kind === 'job_started') jobs += 1;
    if (entry.kind === 'tool_failed') {
      if (entry.toolFailure?.reason === 'plan_gate') held += 1;
      else problems += 1;
    }
    if (entry.kind === 'job_failed') problems += 1;
    if (entry.kind === 'evidence_source' && entry.evidenceSource?.failed) sourcesDown += 1;
  });
  return { steps, toolCalls, jobs, problems, sourcesDown, held };
}

/**
 * How long a wait took, in the units a person would say it in.
 *
 * Whole seconds under a minute and `m:ss` above, because a turn that took 4.2 s and one that took
 * 3 minutes are read by different people for different reasons and a single unit serves neither.
 * Sub-second waits round to `0s` rather than to a decimal nobody can act on.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}
