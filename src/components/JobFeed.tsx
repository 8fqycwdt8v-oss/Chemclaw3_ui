/**
 * Durable jobs that finished *outside* a turn.
 *
 * A conformer search takes minutes to hours. It is launched inside one conversation turn, which ends long
 * before the cluster does, and the backend pushes the completion back over
 * `GET /sessions/{id}/events` whenever it lands.
 *
 * Which means the completion almost never arrives while the chemist is looking at the conversation
 * that launched it. So the feed is not scoped to the open conversation: cards from elsewhere say
 * where they came from and link back. `useJobStreams` watches several sessions to make that
 * possible.
 *
 * Rendered as its own band rather than as chat messages, deliberately. The transcript is what the
 * backend persisted for the conversation; these completions are not part of it, and injecting them
 * would make the visible history disagree with the durable one — the same reason the backend keeps
 * `session_events` and `session_messages` apart.
 *
 * Dismissal sets a flag rather than deleting. The feed survives a reload now, so an unguarded
 * click on a small control would otherwise permanently destroy the only copy — the backend's is
 * consumed by the time the card arrives.
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
 * One title per conversation, which is all a card needs to name where its job came from.
 *
 * Exported, and that is the whole point of it being a named function rather than an inline arrow:
 * `tests/renderStorm.test.tsx` pins that a token flush does not change what this returns, and the
 * arm that used to retype the projection would have gone on passing over a selector widened back
 * to the whole map. Its two siblings there — `visibleConversationIds` and `watchedSessionKey` —
 * are imported for that reason; this one was the copy. The same file also scans this module for a
 * second whole-map read, which is what stops the extraction from being defeated by the component
 * simply not using it.
 *
 * Selecting the conversation map whole put this panel on the per-token render path, because
 * `updateAssistant` replaces that map on every animation-frame flush. A record of titles changes
 * when a conversation is named, which is once.
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
                    <JobResultCard jobId={item.event.job_id} summary={item.event.summary} />
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
