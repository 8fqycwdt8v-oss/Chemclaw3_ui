/**
 * Durable jobs that finished outside a turn, pushed back over `GET /sessions/{id}/events`.
 *
 * Not scoped to the open conversation: completions usually land elsewhere, so cards name their
 * conversation and link back (`useJobStreams` watches several sessions). A separate band rather
 * than chat messages, since these are not part of the persisted transcript. Dismissal sets a flag
 * rather than deleting: the feed persists and this is the only copy.
 */

import { useShallow } from 'zustand/react/shallow';
import { useEffect, useRef, useState } from 'react';
import { Undo2, X } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useChatStore } from '../state/chatStore.ts';
import { relativeTime } from '../lib/format.ts';
import { cn } from '../lib/cn.ts';
import { JobFailureCard, JobResultCard } from './JobResultCard.tsx';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * One title per conversation, all a card needs. A narrow selector: the whole conversation map
 * changes on every token flush, titles change once. Exported so `tests/renderStorm.test.tsx` can
 * pin that.
 */
export const jobFeedTitles = (s: {
  conversations: Record<string, { title: string }>;
}): Record<string, string> =>
  Object.fromEntries(Object.entries(s.conversations).map(([id, c]) => [id, c.title]));

export function JobFeed(): React.JSX.Element | null {
  const jobFeed = useChatStore((s) => s.jobFeed);
  const activeId = useChatStore((s) => s.activeId);
  const titles = useChatStore(useShallow(jobFeedTitles));
  const dismiss = useChatStore((s) => s.dismissJobItem);
  const restore = useChatStore((s) => s.restoreJobItem);
  const [undoable, setUndoable] = useState<string | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigate = useNavigate();

  useEffect(() => () => void (undoTimer.current && clearTimeout(undoTimer.current)), []);

  const visible = jobFeed.filter((j) => !j.dismissed).sort((a, b) => b.receivedAt - a.receivedAt);

  const onDismiss = (jobId: string): void => {
    dismiss(jobId);
    setUndoable(jobId);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndoable(null), 8000);
  };

  if (visible.length === 0 && !undoable) return null;

  return (
    <section
      aria-label="Finished background jobs"
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
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                restore(undoable);
                setUndoable(null);
              }}
            >
              <Undo2 />
              Undo dismiss
            </Button>
          )}
        </div>

        {visible.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {visible.map((item) => {
              const elsewhere = item.conversationId && item.conversationId !== activeId;
              const title = item.conversationId ? titles[item.conversationId] : undefined;
              return (
                <li
                  key={item.event.job_id}
                  className={cn(
                    'relative rounded-lg border p-3 pr-8 shadow-xs',
                    // Tinted at the card level, not just in the text: a failure and a success in
                    // the same row of cards have to be distinguishable before either is read.
                    item.event.type === 'job_failed'
                      ? 'border-danger/40 bg-danger-soft'
                      : 'border-border-subtle bg-surface-raised',
                  )}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => onDismiss(item.event.job_id)}
                        aria-label={`Dismiss job ${item.event.job_id}`}
                        className="tap-target absolute top-1.5 right-1.5"
                      >
                        <X />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Dismiss — you can undo for a few seconds</TooltipContent>
                  </Tooltip>

                  {item.event.type === 'job_failed' ? (
                    <JobFailureCard jobId={item.event.job_id} reason={item.event.reason} />
                  ) : (
                    <JobResultCard
                      jobId={item.event.job_id}
                      summary={item.event.summary}
                      sessionId={item.sessionId}
                      conversationId={item.conversationId}
                    />
                  )}

                  <p className="mt-2 flex flex-wrap items-center gap-x-2 text-2xs text-ink-subtle">
                    {/* "Seen", not "finished": the backend sends no completion time, and a job may
                        have completed long before the stream delivered it. */}
                    <span>seen {relativeTime(item.receivedAt)}</span>
                    {elsewhere && title && (
                      <Button
                        variant="link"
                        size="xs"
                        className="h-auto p-0 text-2xs"
                        onClick={() => void navigate(`/c/${item.conversationId}`)}
                      >
                        from “{title}”
                      </Button>
                    )}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
