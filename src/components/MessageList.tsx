/**
 * The transcript.
 *
 * While a turn streams we render the accumulated tokens as plain pre-wrap text and only switch to
 * full markdown once the answer settles. Re-parsing markdown on every animation frame is both
 * expensive and visually unstable — an unbalanced code fence makes the whole answer flicker
 * between "code block" and "prose" as the closing backticks arrive.
 *
 * `Bubble` is memoised. `updateAssistant` replaces the conversations map, the conversation and the
 * messages array on every rAF flush, but its `.map()` returns the *same object* for messages it
 * did not touch — so a finished bubble's props are referentially stable and the default shallow
 * compare is enough to keep it out of the per-token render path. Without this, every settled
 * answer in the transcript re-rendered its parsed markdown ~60 times a second.
 *
 * Do NOT give any of these a custom `areEqual`. One forgotten field and a streaming answer freezes
 * mid-sentence — the most expensive regression available here, and the one no unit test catches.
 *
 * Nothing carries `aria-live`. Text that mutates once per frame makes a screen reader queue every
 * mutation and stutter through the answer from the top; `aria-busy` plus the transition
 * announcements in `Announcer` say the same thing once each.
 */

import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import { FlaskConical } from 'lucide-react';
import type { AssistantMessage, ChatMessage, Conversation } from '../state/types.ts';
import { Markdown } from './LazyMarkdown.tsx';
import { TracePanel } from './TracePanel.tsx';
import { AnswerFooter, CapabilityDegradedPill, ReviewRequiredPill } from './AnswerBadges.tsx';
import { ApprovalPrompt, QuestionPrompt } from './Prompts.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { ElapsedTimer } from '@/components/chem/ElapsedTimer';
import { EmptyState } from '@/components/chem/Feedback';
import { cn } from '@/lib/utils';

const PlanChecklist = memo(function PlanChecklist({
  todos,
}: {
  todos: string[];
}): React.JSX.Element | null {
  if (todos.length === 0) return null;
  return (
    <div className="mb-3 rounded-lg border border-border-subtle bg-surface-sunken px-3 py-2.5">
      <p className="mb-1.5 text-2xs font-medium tracking-wide text-ink-subtle uppercase">Plan</p>
      <ul className="space-y-1">
        {todos.map((todo, i) => (
          <li key={i} className="flex gap-2 text-sm">
            <span
              aria-hidden
              className="mt-1.5 size-1.5 shrink-0 rounded-[1px] border border-ink-subtle"
            />
            <span>{todo}</span>
          </li>
        ))}
      </ul>
    </div>
  );
});

const AssistantBubble = memo(function AssistantBubble({
  message,
  sessionId,
}: {
  message: AssistantMessage;
  /** Threaded down for the plan gate, which is answered per session rather than per message. */
  sessionId: string | null;
}): React.JSX.Element {
  // finalText wins outright. answer.text is the full concatenation of every token, so anything
  // that combined the two would render the entire answer twice.
  const body = message.finalText ?? message.streamedText;
  const streaming = message.status === 'streaming';

  const question = message.trace.findLast?.((e) => e.kind === 'question')?.question;
  const approval = message.trace.findLast?.((e) => e.kind === 'approval_request')?.approval;

  return (
    <div className="max-w-none" aria-busy={streaming || undefined}>
      <CapabilityDegradedPill message={message} />
      <ReviewRequiredPill message={message} />
      {message.latestPlan && <PlanChecklist todos={message.latestPlan} />}

      {body ? (
        streaming ? (
          <div className="text-base leading-relaxed whitespace-pre-wrap">
            {body}
            <span className="caret" aria-hidden>
              ▌
            </span>
          </div>
        ) : (
          <ErrorBoundary
            resetKey={message.id}
            fallback={() => (
              <div className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2">
                <p className="text-sm text-warn-ink">
                  This answer could not be formatted for display. The text as the service sent it:
                </p>
                <pre className="mt-2 overflow-x-auto font-mono text-xs whitespace-pre-wrap">
                  {body}
                </pre>
              </div>
            )}
          >
            <Markdown>{body}</Markdown>
          </ErrorBoundary>
        )
      ) : (
        streaming && (
          <p className="flex items-center gap-2 text-sm text-ink-muted">
            {/* "Thinking…" is untrue while the turn is parked on admission control: nothing is
                running yet. The distinction is the point of the event — a queued turn and a hung
                server used to look identical from here.

                The elapsed time is a SIBLING node, never concatenated in: a ten-minute turn needs
                a sign of life, but the sentence itself has to stay one stable string. */}
            <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-brand" />
            {message.queued ? 'Waiting for a free slot on the server…' : 'Thinking…'}
            <ElapsedTimer since={message.at} />
          </p>
        )
      )}

      {message.status === 'aborted' && (
        <p className="mt-2 text-xs text-ink-muted">Stopped before the answer was complete.</p>
      )}

      {message.error && (
        // Deliberately NOT role="alert". `failTurn` raises a banner carrying the same sentence,
        // and that one already announces — two alerts with identical text read it out twice.
        <div className="mt-2 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2">
          <p className="text-sm text-danger-ink">{message.error.message}</p>
        </div>
      )}

      {question && <QuestionPrompt question={question.question} options={question.options} />}
      {approval && (
        <ApprovalPrompt
          prompt={approval.prompt}
          approvalId={approval.approvalId}
          sessionId={sessionId}
        />
      )}

      <AnswerFooter message={message} />
      <TracePanel trace={message.trace} />
    </div>
  );
});

const Bubble = memo(function Bubble({
  message,
  sessionId,
}: {
  message: ChatMessage;
  sessionId: string | null;
}): React.JSX.Element {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand px-4 py-2.5 text-brand-fg shadow-xs">
          <p className="text-base whitespace-pre-wrap">{message.text}</p>
        </div>
      </div>
    );
  }
  return (
    // An article so heading/landmark navigation lands on whole answers — which starts to matter
    // once model-authored markdown contributes headings of its own.
    <article
      aria-label="Assistant answer"
      tabIndex={-1}
      className={cn(
        'rounded-2xl rounded-bl-md border border-border-subtle bg-surface-raised px-4 py-3.5 shadow-xs',
        'focus-ring',
      )}
    >
      <AssistantBubble message={message} sessionId={sessionId} />
    </article>
  );
});

export function MessageList({ conversation }: { conversation: Conversation }): React.JSX.Element {
  const endRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Keep the view pinned to the bottom while streaming, but stop fighting the user the moment they
  // scroll up to read something earlier. An IntersectionObserver on the sentinel rather than a
  // scroll listener: no per-event geometry reads on the streaming path.
  useEffect(() => {
    const sentinel = endRef.current;
    const root = scrollerRef.current;
    if (!sentinel || !root) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        pinnedRef.current = entry?.isIntersecting ?? true;
      },
      { root, rootMargin: '0px 0px 80px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  const messages = conversation.messages;

  // Layout effect so the scroll lands in the same frame as the paint. Assigning scrollTop is
  // cheaper than scrollIntoView and does not walk the tree looking for a scroll container.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div
      ref={scrollerRef}
      id="transcript"
      tabIndex={-1}
      className="flex-1 overflow-y-auto overscroll-contain scroll-pt-20 scroll-pb-28 px-4 py-6 focus-visible:outline-none"
    >
      <h2 className="sr-only-live">Conversation</h2>

      <div className="mx-auto flex w-full max-w-prose flex-col gap-5">
        {conversation.contextLost && (
          <div role="alert" className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2.5">
            <p className="text-sm text-warn-ink">
              This conversation’s server session was replaced. The assistant no longer remembers the
              turns above — restate anything it needs.
            </p>
          </div>
        )}

        {messages.length === 0 && (
          <EmptyState icon={<FlaskConical className="size-5" />} title="Chemclaw">
            Process &amp; analytical development assistant. Ask about a reaction, a property, or
            what to run next.
          </EmptyState>
        )}

        {messages.map((message) => (
          <Bubble key={message.id} message={message} sessionId={conversation.sessionId} />
        ))}
        <div ref={endRef} className="h-px" />
      </div>
    </div>
  );
}
