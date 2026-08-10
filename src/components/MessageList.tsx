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

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronUp, FlaskConical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AssistantMessage, ChatMessage } from '../state/types.ts';
import { Markdown } from './LazyMarkdown.tsx';
import { TracePanel } from './TracePanel.tsx';
import { AnswerFooter, CapabilityDegradedPill, ReviewRequiredPill } from './AnswerBadges.tsx';
import { ApprovalPrompt, QuestionPrompt } from './Prompts.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { useChatStore } from '../state/chatStore.ts';
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
      <TracePanel trace={message.trace} sessionId={sessionId} />
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
  const streaming = message.role === 'assistant' && message.status === 'streaming';
  return (
    <div
      // The handle "Load earlier" anchors its scroll restore on. A `data-` attribute rather than a
      // ref map: the restore needs exactly one element, chosen after the render that inserted the
      // others, and threading sixty refs to find it would be a lot of bookkeeping for one query.
      data-message-id={message.id}
      // Skip layout and paint for bubbles scrolled out of view. `auto` on the intrinsic size makes
      // the browser remember each one's real height, so the scrollbar does not jump as they
      // realise — a fixed guess would also fight the trace panel, whose expanded height is many
      // times its collapsed one.
      //
      // The streaming bubble is exempt: the pin below reads `scrollHeight` every frame, and
      // skipping the layout of the element that is actually growing would make it wrong.
      style={
        streaming ? undefined : { contentVisibility: 'auto', containIntrinsicSize: 'auto 220px' }
      }
    >
      <BubbleBody message={message} sessionId={sessionId} />
    </div>
  );
});

function BubbleBody({
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
}

/**
 * Takes an id, not a conversation.
 *
 * `updateAssistant` replaces the conversation object on every animation frame, so a parent that
 * selects the whole object re-renders at the same rate and drags its siblings — the header, the
 * job feed, the composer — with it. Subscribing to the two fields this actually needs keeps that
 * churn inside the transcript, where `memo(Bubble)` already absorbs it.
 */
/** How many messages to render before "Load earlier". A long chemistry transcript is otherwise
 *  hundreds of markdown trees the reader is not looking at. */
const WINDOW_STEP = 60;

export function MessageList({ conversationId }: { conversationId: string }): React.JSX.Element {
  const messages = useChatStore((s) => s.conversations[conversationId]?.messages);
  const sessionId = useChatStore((s) => s.conversations[conversationId]?.sessionId ?? null);
  const contextLost = useChatStore((s) => s.conversations[conversationId]?.contextLost ?? false);

  const endRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  /** Set by "Load earlier": which bubble the reader was looking at, and where it was on screen. */
  const anchorRef = useRef<{ id: string; top: number } | null>(null);

  const [windowSize, setWindowSize] = useState(WINDOW_STEP);

  const total = messages?.length ?? 0;
  // Sliced here rather than in the selector: a selector returning a fresh array would notify on
  // every store write and, with no implicit shallow compare in zustand v5, loop forever.
  const shown = useMemo(
    () => (messages ? messages.slice(Math.max(0, messages.length - windowSize)) : []),
    [messages, windowSize],
  );
  const hidden = total - shown.length;

  const loadEarlier = (): void => {
    const el = scrollerRef.current;
    // Synchronously, before React can re-render: the pin effect below would otherwise still see a
    // stale `true` and slam the reader back to the bottom of a list they just expanded upwards.
    pinnedRef.current = false;
    // Anchor on a real element rather than on `scrollHeight - scrollTop`.
    //
    // The arithmetic version is exact only if `scrollHeight` is truthful at the moment the layout
    // effect runs, and with `content-visibility: auto` it is not: sixty freshly prepended bubbles
    // report `contain-intrinsic-size`'s *estimate* until the browser gets round to laying them out,
    // and every one that then resolves to a different height moves everything below it. Measured on
    // a 663px-tall mobile viewport, that left the reader's message 380px from where it had been —
    // still on screen, but most of a screen away from where they were looking.
    //
    // The first currently-shown bubble is on screen, so it is fully laid out and its position is
    // real. Recording where it is now, and putting it back there afterwards, is immune to every
    // estimate above it being wrong.
    const first = shown[0];
    const node = first ? el?.querySelector(`[data-message-id="${CSS.escape(first.id)}"]`) : null;
    anchorRef.current =
      node && el ? { id: first!.id, top: node.getBoundingClientRect().top } : null;
    setWindowSize((n) => n + WINDOW_STEP);
  };

  // Declared ABOVE the pin effect on purpose — layout effects run in source order, and this one
  // has to restore the offset before anything else touches scrollTop. Prepending content leaves
  // scrollTop numerically unchanged, which throws the reader forward by the inserted height.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (!el || !anchor) return;
    const node = el.querySelector(`[data-message-id="${CSS.escape(anchor.id)}"]`);
    if (!node) return;
    // Relative, not absolute: scrolling by how far the anchor moved needs no view of the document's
    // total height, which is the number that cannot be trusted here.
    el.scrollTop += node.getBoundingClientRect().top - anchor.top;
  }, [shown]);

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

  // Layout effect so the scroll lands in the same frame as the paint. Assigning scrollTop is
  // cheaper than scrollIntoView and does not walk the tree looking for a scroll container.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  return (
    <div
      ref={scrollerRef}
      id="transcript"
      tabIndex={-1}
      className="flex-1 overflow-y-auto overscroll-contain scroll-pt-20 scroll-pb-28 px-4 py-6 focus-visible:outline-none"
    >
      <h2 className="sr-only-live">Conversation</h2>

      <div className="mx-auto flex w-full max-w-prose flex-col gap-5">
        {contextLost && (
          <div role="alert" className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2.5">
            <p className="text-sm text-warn-ink">
              This conversation’s server session was replaced. The assistant no longer remembers the
              turns above — restate anything it needs.
            </p>
          </div>
        )}

        {hidden > 0 && (
          <div className="flex justify-center">
            <Button variant="outline" size="sm" onClick={loadEarlier}>
              <ChevronUp />
              Load earlier ({hidden} {hidden === 1 ? 'message' : 'messages'})
            </Button>
          </div>
        )}

        {total === 0 && (
          <EmptyState icon={<FlaskConical className="size-5" />} title="Chemclaw">
            Process &amp; analytical development assistant. Ask about a reaction, a property, or
            what to run next.
          </EmptyState>
        )}

        {shown.map((message) => (
          <Bubble key={message.id} message={message} sessionId={sessionId} />
        ))}
        <div ref={endRef} className="h-px" />
      </div>
    </div>
  );
}
