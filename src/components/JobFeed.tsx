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
 * Dismissal is local and non-destructive — but it is also the ONLY copy: the backend's claim is
 * consumed by the time the card arrives, so there is nothing to re-fetch. Hence the undo, and
 * hence `role="status"` rather than silence: a completion that lands while the chemist is reading
 * something else should announce itself once, politely.
 */

import { useRef, useState } from 'react';
import { Undo2, X } from 'lucide-react';
import type { JobCompletedEvent } from '../../shared/events.ts';
import { useChatStore } from '../state/chatStore.ts';
import { JobResultCard } from './JobResultCard.tsx';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function JobFeed(): React.JSX.Element | null {
  const jobFeed = useChatStore((s) => s.jobFeed);
  const dismiss = useChatStore((s) => s.dismissJobCompleted);
  const restore = useChatStore((s) => s.pushJobCompleted);
  const [undoable, setUndoable] = useState<JobCompletedEvent | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onDismiss = (job: JobCompletedEvent): void => {
    dismiss(job.job_id);
    setUndoable(job);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndoable(null), 8000);
  };

  const onUndo = (): void => {
    if (undoable) restore(undoable);
    setUndoable(null);
  };

  if (jobFeed.length === 0 && !undoable) return null;

  return (
    <section
      aria-label="Completed background jobs"
      role="status"
      aria-live="polite"
      className="border-t border-border-subtle bg-surface-sunken px-4 py-3"
    >
      <div className="mx-auto w-full max-w-prose">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-2xs font-medium tracking-wide text-ink-subtle uppercase">
            Finished in the background
          </h2>
          {undoable && (
            <Button variant="ghost" size="xs" onClick={onUndo}>
              <Undo2 />
              Undo dismiss
            </Button>
          )}
        </div>

        {jobFeed.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {jobFeed.map((job) => (
              <li
                key={job.job_id}
                className="relative rounded-lg border border-border-subtle bg-surface-raised p-3 pr-8 shadow-xs"
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => onDismiss(job)}
                      aria-label={`Dismiss job ${job.job_id}`}
                      className="tap-target absolute top-1.5 right-1.5"
                    >
                      <X />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Dismiss — this is the only copy, but you can undo</TooltipContent>
                </Tooltip>
                <JobResultCard jobId={job.job_id} summary={job.summary} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
