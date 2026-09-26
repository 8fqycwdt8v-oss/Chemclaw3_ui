/**
 * On taking the streams, ask the run registry how every run this account is waiting on ended.
 *
 * `ISSUES.md` Issue 12: the service's claim on a job ending is destructive (`claim_unconsumed`, one
 * `UPDATE … RETURNING`, at-most-once), so a `job_completed` frame already written to a tab's socket
 * is gone from the mailbox. A leader that dies between reading that frame and `publish`ing it takes
 * the ending with it, and no reconnect brings it back. The window is accepted — it is the
 * browser-side gap between a frame arriving and a synchronous `publish`, microseconds for a closed
 * tab and wider only for a killed or crashed one — and this is what shrinks its cost from "never
 * told" to "told late".
 *
 * **Why the registry can answer, checked against the service rather than assumed.** `GET
 * /jobs/{id}` is `job_status` in `chemclaw/agent/durable_tools.py` (read at Chemclaw3 `03807b52`):
 * Temporal while it remembers the run, `job_records` afterwards, and it maps every terminal
 * Temporal state to one word — `completed`, `failed`, `cancelled`, `terminated`, `timed_out` — or
 * answers `running`. A failed run's cause comes back as `summary` on both paths. That is exactly
 * the fact the lost frame carried, so a new leader can recover it: no acknowledgement protocol is
 * needed for the *fact* of an ending. What it does not return is the lost frame itself: the
 * registry answers with the run's decoded `result` and a one-line `summary`, not the push-back's
 * payload object, so a reconciled card is built from `result` and may show different fields from
 * the card the stream would have produced. Recorded in Issue 12.
 *
 * **Which runs are asked about.** The ones this browser saw launched and has not seen end: a
 * `job_started` row in a conversation's trace, not settled, with no ending in the trace and no
 * card in the job feed. The ending that was lost is by construction one of these — its launch
 * reached this account's store and its ending did not. Bounded twice, because this runs on every
 * takeover and on every first election at page load: only launches inside the job feed's own
 * retention window (an older ending would be dropped from the feed on arrival anyway, and a
 * launch that old whose card aged out would otherwise be re-announced as news), and at most
 * `RECONCILE_MAX_JOBS`, newest first.
 *
 * **What it does with an answer** is exactly what the stream would have done: the ending goes
 * through `tab.publish`, so every window on the account gets it, and the store's handler is
 * idempotent on `job_id` — so a run whose ending the stream also delivers (the mailbox row was
 * never claimed, or is claimed a second later) costs nothing, in either order. A run still
 * `running`, a registry that errors, or a job id the service no longer knows is left alone: the
 * stream is still the channel for those, and a failed read is not evidence of anything.
 */

import { api, type TokenGetter, type DurableJobStatus } from '../api/client.ts';
import { normalizeEvent, type JobTerminalEvent } from '../../shared/events.ts';
import { logger } from '../lib/logger.ts';
import type { ChatState } from './chatStore.ts';
import type { StreamLeader } from './jobStreamLeader.ts';

/** How many runs one takeover asks about, at most. Each is one `GET /jobs/{id}`. */
export const RECONCILE_MAX_JOBS = 10;

/**
 * How old a launch may be and still be asked about — the job feed's own retention.
 *
 * The same seven days `chatStore.ts` ages feed cards on (`JOB_FEED_MAX_AGE_MS`), and for the reason
 * the module docstring gives: an ending for a launch older than that would be dropped by the feed's
 * next persist, so fetching it buys nothing, and a launch that old whose card has already aged out
 * would be announced again as if it were news.
 */
export const RECONCILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** One run the account saw launched and has not seen end. */
export interface AwaitedJob {
  jobId: string;
  sessionId: string;
  startedAt: number;
}

/**
 * The runs this store saw launched and never saw end, newest first, bounded.
 *
 * Read from the store rather than kept alongside it, so there is no second list of "running jobs"
 * that could disagree with the trace the chemist is looking at.
 */
export function awaitedJobs(state: ChatState, now = Date.now()): AwaitedJob[] {
  const ended = new Set(state.jobFeed.map((item) => item.event.job_id));
  const found = new Map<string, AwaitedJob>();
  for (const conversation of Object.values(state.conversations)) {
    const sessionId = conversation.sessionId;
    if (!sessionId) continue;
    for (const message of conversation.messages) {
      const trace = 'trace' in message ? message.trace : undefined;
      if (!Array.isArray(trace)) continue;
      for (const entry of trace) {
        if (entry.kind === 'job_completed' && entry.job?.jobId) ended.add(entry.job.jobId);
        if (entry.kind === 'job_failed' && entry.jobFailure?.jobId) {
          ended.add(entry.jobFailure.jobId);
        }
      }
      for (const entry of trace) {
        if (entry.kind !== 'job_started' || !entry.job?.jobId || entry.job.settled) continue;
        if (entry.at <= now - RECONCILE_WINDOW_MS) continue;
        const known = found.get(entry.job.jobId);
        if (!known || entry.at > known.startedAt) {
          found.set(entry.job.jobId, { jobId: entry.job.jobId, sessionId, startedAt: entry.at });
        }
      }
    }
  }
  return [...found.values()]
    .filter((job) => !ended.has(job.jobId))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, RECONCILE_MAX_JOBS);
}

/**
 * The ending the stream would have delivered, from what the registry says — or `null` while the
 * run is still going.
 *
 * Built through `normalizeEvent`, the stream's own parser, so a reconciled ending is held to the
 * same schema as a streamed one and cannot carry a shape the feed has never seen.
 */
export function terminalEventFrom(status: DurableJobStatus): JobTerminalEvent | null {
  if (status.status === 'running') return null;
  const event =
    status.status === 'completed'
      ? normalizeEvent({ type: 'job_completed', job_id: status.job_id, summary: status.result })
      : normalizeEvent({
          type: 'job_failed',
          job_id: status.job_id,
          // The service's own cause when it has one; otherwise the state word, because
          // `cancelled` or `timed_out` is itself the reason and "" would say nothing.
          reason: status.summary || status.status,
        });
  return event && (event.type === 'job_completed' || event.type === 'job_failed') ? event : null;
}

/**
 * Ask the registry about every awaited run and publish the endings it reports.
 *
 * Resolves to the number of endings published. Never rejects: every read that fails is logged and
 * skipped, because this is a backstop for a rare loss and must not become a failure of its own.
 */
export async function reconcileAfterTakeover(
  tab: StreamLeader,
  state: ChatState,
  getToken: TokenGetter,
  getJob: (jobId: string, getToken: TokenGetter) => Promise<DurableJobStatus> = api.getJob,
): Promise<number> {
  const awaited = awaitedJobs(state);
  if (awaited.length === 0) return 0;
  let published = 0;
  await Promise.all(
    awaited.map(async (job) => {
      try {
        const event = terminalEventFrom(await getJob(job.jobId, getToken));
        if (!event) return;
        tab.publish({ kind: 'job', event, sessionId: job.sessionId });
        published += 1;
      } catch (error) {
        logger.warn('jobs.reconcile_read_failed', {
          job_id: job.jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
  if (published > 0) logger.info('jobs.reconciled', { asked: awaited.length, published });
  return published;
}
