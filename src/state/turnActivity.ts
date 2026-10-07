/**
 * What the turn is doing now, and what it did once over — pure functions over the message, so they
 * cannot drift from the store.
 *
 * A turn can be several things at once, so they are ranked: queued → an open tool call → text
 * arriving → an unsettled durable job → the plan → thinking. Queued first (nothing runs yet); an
 * open call above tokens (the turn is blocked on it); a durable job below tokens (it does not block
 * the turn).
 */

import { isRefusal } from '../lib/refusals.ts';
import type { AssistantMessage, TraceEntry } from './types.ts';

/** Where the plan has got to, when the service told us. */
export interface PlanPosition {
  /** 1-based, over every step including the finished ones. */
  index: number;
  total: number;
  /** The step's own text, with the `[x] `/`[ ] ` prefix already off. */
  text: string;
}

export type ActivityKind =
  'queued' | 'planning' | 'tool_queued' | 'tool' | 'writing' | 'job' | 'thinking';

export interface TurnActivity {
  kind: ActivityKind;
  /** The sentence. One clause, present tense, no ellipsis of its own. */
  label: string;
  /** The identifier beside it — a tool name, a job id — or empty when there is none. */
  detail: string;
  /** The plan step this is happening under, when a plan is running. */
  step: PlanPosition | null;
  /**
   * `waiting` (durable job, admission queue) is out of this process's hands, so the dot does not
   * pulse.
   */
  tone: 'busy' | 'waiting';
}

/**
 * The plan step in progress: the first not marked done. `null` unless some step carries a status
 * prefix (a plan read back after reload has none).
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

/** Where a queued message stands in a shared line; `0` is next. */
export function linePlace(position: number): string {
  if (position <= 0) return 'Next in line — waiting for the turn in progress to finish';
  return `Waiting in line — ${position} ${position === 1 ? 'message' : 'messages'} ahead of yours`;
}

/**
 * What this streaming turn is doing (only meaningful while streaming; see `summarizeTurn` for
 * settled turns).
 */
export function turnActivity(message: AssistantMessage): TurnActivity {
  const step = planPosition(message.latestPlan);
  const trace = message.trace;

  // Before anything else has happened: a place in a shared line (said with its position), or the
  // admission wait.
  if (message.queuePlace && trace.length === 0 && !message.streamedText) {
    return {
      kind: 'queued',
      label: linePlace(message.queuePlace.position),
      detail: '',
      step: null,
      tone: 'waiting',
    };
  }

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
  if (call?.toolCall?.queue?.state === 'queued') {
    // A queued call waits for a compute slot: the `waiting` tone, and its own kind so the change is
    // announced.
    return {
      kind: 'tool_queued',
      label: 'Waiting for a compute slot',
      detail: call.toolCall.tool,
      step,
      tone: 'waiting',
    };
  }
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
 * The one sentence announced when the row changes, through the app's single polite region
 * (`state/announce.ts`), never a live region on a ticking row.
 */
export function describeActivity(activity: TurnActivity): string {
  const where = activity.step ? ` Step ${activity.step.index} of ${activity.step.total}.` : '';
  switch (activity.kind) {
    case 'queued':
      return `${activity.label}.`;
    case 'planning':
      return `Reading the plan.${where}`;
    case 'tool_queued':
      return `Waiting for a compute slot for ${activity.detail}.${where}`;
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
   * Retrieval sources whose retriever raised during a sweep, counted apart from failures (different
   * remedy).
   */
  sourcesDown: number;
  /** Calls a gate refused, counted apart from failures: a refusal is the control working. */
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
  // A handoff is work: it is the turn deciding which agent does the rest of it, and a summary
  // that omitted it would show two agents' steps as one agent's.
  'handoff',
]);

/** Consecutive `evidence_source` rows are one sweep, counted as one step like the rail shows. */
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
      // `isRefusal`, shared with `TracePanel`, so both agree on what counts.
      if (isRefusal(entry.toolFailure?.reason)) held += 1;
      else problems += 1;
    }
    if (entry.kind === 'job_failed') problems += 1;
    if (entry.kind === 'evidence_source') {
      // Count over the whole sweep, not its first source; `evidenceSource` covers transcripts
      // persisted before `evidenceSweep`.
      const sweep = entry.evidenceSweep ?? (entry.evidenceSource ? [entry.evidenceSource] : []);
      sourcesDown += sweep.filter((s) => s.failed).length;
    }
  });
  return { steps, toolCalls, jobs, problems, sourcesDown, held };
}

/** A duration as a person says it: whole seconds under a minute, `m:ss` above. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}
