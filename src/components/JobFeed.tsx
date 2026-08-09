/**
 * Durable jobs that finished *outside* a turn.
 *
 * A DFT run takes minutes to days. It is launched inside one conversation turn, which ends long
 * before the cluster does, and the backend pushes the completion back over
 * `GET /sessions/{id}/events` whenever it lands. `useJobFeed` has always consumed that stream —
 * correctly, with backoff and abort handling — and written each completion into `jobFeed`, where
 * **nothing read it**. So the entire push-back path (the `session_events` mailbox, the dedupe keys,
 * the at-most-once claim) worked end to end and died one step from the chemist.
 *
 * Rendered as its own band rather than as chat messages, deliberately. The transcript is what the
 * backend persisted for the conversation; these completions are not part of it, and injecting them
 * would make the visible history disagree with the durable one — the same reason the backend keeps
 * `session_events` and `session_messages` apart. So this reads as what it is: a notification area
 * about work still in flight, not a thing the agent said.
 *
 * Dismissal is local and non-destructive. The backend's copy is already consumed by the time it
 * arrives here, so this only clears the card.
 */

import { cn } from '../lib/cn.ts';
import { useChatStore } from '../state/chatStore.ts';
import { JobResultCard } from './JobResultCard.tsx';

/**
 * A job that was announced as running and then failed.
 *
 * Its own card rather than a variant of the result card: the two say opposite things, and the
 * result card is built to read a chemistry summary that a failure does not have. `reason` is the
 * innermost message in Temporal's failure chain — the outer ones only say "child workflow
 * execution failed".
 */
function JobFailureCard({ jobId, reason }: { jobId: string; reason: string }): React.JSX.Element {
  return (
    <div className="max-w-xs">
      <p className="text-xs font-medium text-danger">Job failed</p>
      <p className="mt-0.5 font-mono text-[0.7rem] break-all text-ink-muted">{jobId}</p>
      {reason && <p className="mt-1.5 text-xs break-words">{reason}</p>}
    </div>
  );
}

export function JobFeed(): React.JSX.Element | null {
  const jobFeed = useChatStore((s) => s.jobFeed);
  const dismiss = useChatStore((s) => s.dismissJobEvent);

  if (jobFeed.length === 0) return null;

  return (
    <section
      aria-label="Background jobs that finished"
      className="border-t border-border-subtle bg-surface-sunken px-4 py-3"
    >
      <h2 className="mb-2 text-xs font-medium tracking-wide text-ink-muted uppercase">
        Finished in the background
      </h2>
      <ul className="flex flex-wrap gap-2">
        {jobFeed.map((job) => (
          <li
            key={job.job_id}
            className={cn(
              'relative rounded-md border p-3',
              job.type === 'job_failed'
                ? 'border-danger/40 bg-danger-soft'
                : 'border-border-subtle bg-surface-raised',
            )}
          >
            <button
              type="button"
              onClick={() => dismiss(job.job_id)}
              aria-label={`Dismiss job ${job.job_id}`}
              className="absolute top-1 right-1 rounded px-1 text-xs text-ink-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              ×
            </button>
            {job.type === 'job_failed' ? (
              <JobFailureCard jobId={job.job_id} reason={job.reason} />
            ) : (
              <JobResultCard jobId={job.job_id} summary={job.summary} />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
