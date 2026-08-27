/**
 * Which plan step has a durable job behind it, and how that job is doing.
 *
 * The join the backend's D-2026-08-27 stamp exists for: a `job_started` trace row carries the
 * step's bare text (`planStep`), so the plan card can badge the checklist item a running job
 * belongs to — the difference between "step 2 is waiting on a six-hour search" and "the plan
 * stalled".
 *
 * A job's ending arrives on two different channels, and this reads both deliberately. Inside the
 * turn, `job_completed`/`job_failed` land as trace rows on the same message. After the turn —
 * the normal case for a durable job — they arrive through the session's event stream and land in
 * the global `jobFeed` (`pushJobFinished`), which never touches the trace. Reading only the trace
 * would leave a chip spinning forever for every job that outlived its turn, which is exactly the
 * population the chip matters for.
 *
 * A pure function over both, rather than store state: nothing new to persist, nothing to migrate,
 * and the derivation is testable without rendering anything.
 */

import type { JobFeedItem } from './chatStore.ts';
import type { TraceEntry } from './types.ts';

export type PlanStepJobStatus = 'running' | 'done' | 'failed';

/** `running` outranks `failed` outranks `done`: with several jobs on one step, the chip shows the
 *  most actionable fact — something still in flight, else something that went wrong. */
const RANK: Record<PlanStepJobStatus, number> = { running: 2, failed: 1, done: 0 };

export function planStepJobs(
  trace: readonly TraceEntry[],
  jobFeed: readonly JobFeedItem[],
): Map<string, PlanStepJobStatus> {
  const byStep = new Map<string, PlanStepJobStatus>();
  for (const entry of trace) {
    if (entry.kind !== 'job_started' || !entry.job?.planStep) continue;
    const id = entry.job.jobId;
    const failed =
      trace.some((e) => e.kind === 'job_failed' && e.jobFailure?.jobId === id) ||
      jobFeed.some((j) => j.event.job_id === id && j.event.type === 'job_failed');
    const done =
      trace.some((e) => e.kind === 'job_completed' && e.job?.jobId === id) ||
      jobFeed.some((j) => j.event.job_id === id && j.event.type === 'job_completed');
    const status: PlanStepJobStatus = failed ? 'failed' : done ? 'done' : 'running';
    const existing = byStep.get(entry.job.planStep);
    if (existing === undefined || RANK[status] > RANK[existing]) {
      byStep.set(entry.job.planStep, status);
    }
  }
  return byStep;
}
