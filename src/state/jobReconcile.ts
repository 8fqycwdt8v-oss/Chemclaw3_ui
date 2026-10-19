/**
 * On taking the streams, ask the run registry how every awaited run ended (`ISSUES.md` Issue 12).
 * The service's claim on a job ending is destructive, so a leader that dies between reading a frame
 * and relaying it loses it; this turns "never told" into "told late".
 *
 * `GET /jobs/{id}` maps every terminal state to
 * `completed`/`failed`/`cancelled`/`terminated`/`timed_out` (else `running` or `queued`), with a
 * failure's cause in `summary`. It does not return the push-back payload, so a reconciled card is
 * built from `result`.
 *
 * Asked about: runs this browser saw launched (`job_started`, unsettled, no ending, no feed card),
 * within the feed's retention window and at most `RECONCILE_MAX_JOBS`, newest first. Endings go
 * through `tab.publish`; the store is idempotent on `job_id`. Open runs, errors and unknown ids are
 * left alone.
 */

import { api, type TokenGetter, type DurableJobStatus } from '../api/client.ts';
import { normalizeEvent, type JobTerminalEvent } from '../../shared/events.ts';
import { logger } from '../lib/logger.ts';
import type { ChatState } from './chatStore.ts';
import type { StreamLeader } from './jobStreamLeader.ts';

/** How many runs one takeover asks about, at most. Each is one `GET /jobs/{id}`. */
export const RECONCILE_MAX_JOBS = 10;

/**
 * How old a launch may be and still be asked about: the job feed's seven-day retention
 * (`JOB_FEED_MAX_AGE_MS`).
 */
export const RECONCILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** One run the account saw launched and has not seen end. */
export interface AwaitedJob {
  jobId: string;
  sessionId: string;
  startedAt: number;
}

/**
 * The runs this store saw launched and never saw end, newest first, bounded — derived from the
 * store.
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
 * The words `GET /jobs/{id}` ends a run with (`_TERMINAL` upstream). Listed explicitly, so any
 * other word (e.g. `queued`) is treated as open.
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'terminated',
  'timed_out',
]);

/** Whether the registry says the run is over; shared with `JobsPanel`. */
export function isTerminalJobStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * The ending the stream would have delivered, built through `normalizeEvent`; `null` while the run
 * is open.
 */
export function terminalEventFrom(status: DurableJobStatus): JobTerminalEvent | null {
  if (!TERMINAL_STATUSES.has(status.status)) return null;
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
 * Ask about every awaited run and publish the endings. Resolves to the number published; never
 * rejects (failures are logged and skipped).
 */
export async function reconcileAfterTakeover(
  tab: StreamLeader,
  state: ChatState,
  getToken: TokenGetter,
  getJob: (
    jobId: string,
    getToken: TokenGetter,
    sessionId?: string,
  ) => Promise<DurableJobStatus> = api.getJob,
): Promise<number> {
  const awaited = awaitedJobs(state);
  if (awaited.length === 0) return 0;
  let published = 0;
  await Promise.all(
    awaited.map(async (job) => {
      try {
        // The launch's own session, so a report's `exhibit_id` survives the registry's read and
        // the reconciled card still offers Open report (`api.getJob`).
        const event = terminalEventFrom(await getJob(job.jobId, getToken, job.sessionId));
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
