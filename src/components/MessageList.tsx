/**
 * The transcript.
 *
 * - A streaming answer renders as plain pre-wrap text; markdown is parsed once it settles
 *   (re-parsing per frame is slow and flickers on unbalanced fences).
 * - `Bubble` is memoised: `updateAssistant` keeps untouched messages referentially stable, so
 *   settled bubbles skip the per-token render. Never give these a custom `areEqual` — one forgotten
 *   field freezes a streaming answer.
 * - Nothing carries `aria-live` (per-frame mutations make screen readers stutter); `aria-busy` and
 *   `Announcer` cover it.
 */

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronUp, ClipboardCopy, FlaskConical, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AssistantMessage, ChatMessage, TraceEntry } from '../state/types.ts';
import { Markdown } from './LazyMarkdown.tsx';
import { StructureText } from './Molecule.tsx';
import { TracePanel } from './TracePanel.tsx';
import { StatusStrip } from './StatusStrip.tsx';
import { PlanStrip } from './PlanStrip.tsx';
import { ActivityLine } from './ActivityLine.tsx';
import { ResultBlock } from './ResultBlock.tsx';
import { LazyExhibitCard as ExhibitCard } from './exhibits/lazy.tsx';
import { ApprovalPrompt, QuestionPrompt } from './Prompts.tsx';
import { prefill, prefillAndSend } from '../state/composerEvents.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { useChatStore } from '../state/chatStore.ts';
import { entitiesOf, messagesFor, useEntityStore } from '../chem/entities.ts';
import { returnedFigures } from '../chem/provenance.ts';
import { formatDuration } from '../state/turnActivity.ts';
import { EmptyState } from '@/components/chem/Feedback';
import { cn } from '@/lib/utils';

/**
 * Stored results rendered as blocks under one answer; each is a fetch the reader did not ask for.
 * The rest stay on their trace step.
 */
const MAX_RESULT_BLOCKS = 3;

/**
 * The rail's closing row: the answer itself as a step (words, and time from the last announced step
 * to the end). Absent while streaming and when there is no answer text. Exported for its test.
 */
export function answerStep(message: AssistantMessage): { words: number; duration?: string } | null {
  if (message.status === 'streaming') return null;
  const text = message.finalText || message.streamedText;
  if (!text.trim()) return null;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  // The last instant the trace knows of: a `tool_call` row's result closes it in place, so its `at`
  // is the issue time, not the end.
  const lastStep = message.trace.reduce(
    (latest, entry) =>
      Math.max(latest, entry.at, entry.toolCall?.endedAt ?? 0, entry.job?.endedAt ?? 0),
    0,
  );
  const duration =
    message.endedAt && lastStep > 0 && message.endedAt > lastStep
      ? formatDuration(message.endedAt - lastStep)
      : undefined;
  return { words, duration };
}

/**
 * The turn's results as data under the answer. A call qualifies if its result is stored
 * (`resultRef`, needs a session id to fetch) or inline (`resultInline`); the two are independent.
 */
const ResultBlocks = memo(function ResultBlocks({
  trace,
  sessionId,
}: {
  trace: TraceEntry[];
  sessionId: string | null;
}): React.JSX.Element | null {
  const stored = useMemo(
    () =>
      trace.filter(
        (
          e,
        ): e is TraceEntry & {
          toolCall: {
            tool: string;
            resultRef?: string;
            resultInline?: string;
            resultCut?: boolean;
          };
        } => e.kind === 'tool_call' && Boolean(e.toolCall?.resultRef || e.toolCall?.resultInline),
      ),
    [trace],
  );
  if (!sessionId || stored.length === 0) return null;
  const shown = stored.slice(0, MAX_RESULT_BLOCKS);
  return (
    <>
      {shown.map((entry) => (
        <ResultBlock
          key={entry.id}
          sessionId={sessionId}
          tool={entry.toolCall.tool}
          resultRef={entry.toolCall.resultRef ?? ''}
          inline={entry.toolCall.resultInline}
          cut={entry.toolCall.resultCut === true}
        />
      ))}
      {stored.length > shown.length && (
        <p className="max-w-prose text-2xs text-ink-subtle">
          {stored.length - shown.length} further stored result
          {stored.length - shown.length === 1 ? '' : 's'} — each on its own step below.
        </p>
      )}
    </>
  );
});

/**
 * One card per artefact this turn wrote (the last frame wins, giving the final revision). Memoised
 * on the trace.
 */
const ExhibitCards = memo(function ExhibitCards({
  trace,
  sessionId,
}: {
  trace: TraceEntry[];
  sessionId: string | null;
}): React.JSX.Element | null {
  const latest = useMemo(() => {
    const byId = new Map<string, NonNullable<TraceEntry['exhibit']>>();
    for (const entry of trace) {
      if (entry.kind !== 'exhibit' || !entry.exhibit?.exhibitId) continue;
      byId.delete(entry.exhibit.exhibitId);
      byId.set(entry.exhibit.exhibitId, entry.exhibit);
    }
    return [...byId.values()];
  }, [trace]);
  // The artefact routes are session-scoped, so a card with no session could only fail its Open.
  if (!sessionId || latest.length === 0) return null;
  return (
    <>
      {latest.map((exhibit) => (
        <ExhibitCard key={exhibit.exhibitId} sessionId={sessionId} exhibit={exhibit} />
      ))}
    </>
  );
});

/**
 * Copy the answer's markdown (what goes into an ELN, with citations as text). A browser refusal is
 * shown, not thrown.
 */
function CopyAnswer({ text }: { text: string }): React.JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = (): void => {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      setState('failed');
      return;
    }
    void clipboard.writeText(text).then(
      () => {
        setState('copied');
        // Back to the affordance, so a second copy does not read as already done.
        window.setTimeout(() => setState('idle'), 2_000);
      },
      () => setState('failed'),
    );
  };

  return (
    <div className="mt-1.5 flex items-center gap-2">
      <Button variant="ghost" size="xs" onClick={copy} aria-label="Copy this answer">
        <ClipboardCopy aria-hidden className="size-3.5" />
        {state === 'copied' ? 'Copied' : 'Copy'}
      </Button>
      {state === 'failed' && (
        <span role="status" className="text-2xs text-ink-muted">
          This browser would not take it — select the text instead.
        </span>
      )}
    </div>
  );
}

const AssistantBubble = memo(function AssistantBubble({
  message,
  sessionId,
  retryQuestion,
}: {
  message: AssistantMessage;
  /** Threaded down for the plan gate, which is answered per session rather than per message. */
  sessionId: string | null;
  /** The question to send again, on an answer the service lost (`retryQuestionOf`). */
  retryQuestion?: string;
}): React.JSX.Element {
  // `finalText` wins outright (never concatenated with streamed text). `||`, not `??`: an `answer`
  // with `text: ''` must not erase the streamed tokens.
  const body = message.finalText || message.streamedText;
  const streaming = message.status === 'streaming';

  const question = message.trace.findLast?.((e) => e.kind === 'question')?.question;
  const approval = message.trace.findLast?.((e) => e.kind === 'approval_request')?.approval;

  // Recomputed only when the trace changes. Empty when tools returned no numbers, which turns the
  // grounding overlay off.
  const figures = useMemo(() => returnedFigures(message.trace), [message.trace]);

  return (
    <div className="flex flex-col" aria-busy={streaming || undefined}>
      {/* Qualifiers above the text, ranked: a bar for what stops the reader acting, a chip for what they consult. */}
      <div className="max-w-prose">
        {/* Somebody else's turn, followed live: say so, since a watcher never sees the question. */}
        {message.watched && (
          <p className="mb-1.5 text-2xs text-ink-muted">
            {streaming
              ? 'Another person’s turn, followed live. Their question appears here once it is answered.'
              : 'Another person’s turn. Loading their question…'}
          </p>
        )}
        <StatusStrip message={message} />
        <PlanStrip message={message} trace={message.trace} />
        {/* Only when there is no plan to fold it into: the strip above carries the same live row,
            and two rows saying one thing is the duplication this replaced. */}
        {!message.latestPlan && <ActivityLine message={message} />}
      </div>

      <div className="max-w-prose">
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
              <Markdown figures={figures}>{body}</Markdown>
            </ErrorBoundary>
          )
        ) : (
          // A settled turn with no text says so, so it is not mistaken for a lost answer. Question
          // and approval cards count as content.
          message.status === 'done' &&
          !question &&
          !approval && (
            <p className="text-sm text-ink-muted">
              The turn finished without producing any answer text.
            </p>
          )
        )}
      </div>

      {/* Tool results as tables; a wide one takes the card's full width. */}
      <ResultBlocks trace={message.trace} sessionId={sessionId} />
      {/* The artefacts this answer wrote, after the data it was written from. */}
      <ExhibitCards trace={message.trace} sessionId={sessionId} />

      <div className="max-w-prose">
        {/* Only once the turn has settled: copying half an answer is copying the wrong thing. */}
        {body && !streaming && <CopyAnswer text={body} />}

        {message.status === 'aborted' &&
          (message.withdrawn ? (
            // A withdrawn message never ran, so "stopped before the answer was complete" would be
            // wrong.
            <p className="mt-2 text-xs text-ink-muted">{message.withdrawn}</p>
          ) : (
            <p className="mt-2 text-xs text-ink-muted">Stopped before the answer was complete.</p>
          ))}

        {message.error && (
          // Deliberately NOT role="alert". `failTurn` raises a banner carrying the same sentence,
          // and that one already announces — two alerts with identical text read it out twice.
          <div className="mt-2 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2">
            <p className="text-sm text-danger-ink">{message.error.message}</p>
            {/* Retry for an interrupted turn: nothing will answer it and nothing ran twice, so resending is the remedy. It goes through the composer like any send. */}
            {message.error.kind === 'turn_interrupted' && retryQuestion && (
              <Button
                variant="outline"
                size="xs"
                className="mt-2"
                onClick={() => prefillAndSend(retryQuestion)}
              >
                Retry
              </Button>
            )}
          </div>
        )}

        {question && <QuestionPrompt question={question.question} options={question.options} />}
        {approval && (
          <ApprovalPrompt
            prompt={approval.prompt}
            sessionId={sessionId}
            // Stable identities: both come off the store's message and are replaced only by a new
            // `plan` event, so passing them straight through does not re-run the card's effect.
            planTodos={message.latestPlan}
            planHash={message.latestPlanHash}
            planScope={message.latestPlanScope}
            planAuthor={message.latestPlanAuthor}
          />
        )}
      </div>

      {/* `StatusStrip` above carries confidence, unsupported claims and methods. */}
      <TracePanel
        trace={message.trace}
        sessionId={sessionId}
        correlationId={message.correlationId ?? ''}
        // Our clock, and absent on a rehydrated turn — which is why the summary omits the time
        // rather than reporting zero.
        durationMs={message.endedAt ? message.endedAt - message.at : null}
        plan={message.latestPlan}
        answer={answerStep(message)}
      />
    </div>
  );
});

const Bubble = memo(function Bubble({
  message,
  sessionId,
  sender,
  retryQuestion,
}: {
  message: ChatMessage;
  sessionId: string | null;
  /** Who sent a user message, in a conversation with more than one person — see `senderOf`. */
  sender?: string;
  /** See `retryQuestionOf`. */
  retryQuestion?: string;
}): React.JSX.Element {
  const streaming = message.role === 'assistant' && message.status === 'streaming';
  return (
    <div
      // The anchor "Load earlier" restores scroll against.
      data-message-id={message.id}
      // Skip layout and paint off-screen (`content-visibility: auto` with remembered intrinsic
      // size). Not for the streaming bubble, whose `scrollHeight` the pin reads every frame.
      style={
        streaming ? undefined : { contentVisibility: 'auto', containIntrinsicSize: 'auto 220px' }
      }
    >
      <BubbleBody
        message={message}
        sessionId={sessionId}
        sender={sender}
        retryQuestion={retryQuestion}
      />
    </div>
  );
});

/**
 * The question an interrupted answer would resend, read from the message before it, or `undefined`.
 * Only for `turn_interrupted`, and only for the question's own sender: in a shared conversation
 * Retry would otherwise send someone else's words as the reader's (see `senderOf`). Exported for
 * its test.
 */
export function retryQuestionOf(
  messages: readonly ChatMessage[],
  index: number,
  shared = false,
  me: string | null = null,
): string | undefined {
  const message = messages[index];
  if (message?.role !== 'assistant' || message.error?.kind !== 'turn_interrupted') return undefined;
  const asked = messages[index - 1];
  if (asked?.role !== 'user') return undefined;
  const mine = !shared || asked.author === undefined || asked.author === me;
  return mine ? asked.text : undefined;
}

/**
 * Who a user bubble says sent it, or `undefined`. Only in a conversation with more than one person,
 * where every user bubble is labelled (the reader's too), since the sender's roles answer it. A
 * message sent live is the reader's. Exported for its test.
 */
export function senderOf(
  message: ChatMessage,
  shared: boolean,
  me: string | null,
): string | undefined {
  if (!shared || message.role !== 'user') return undefined;
  return message.author && message.author !== me ? message.author : 'You';
}

function BubbleBody({
  message,
  sessionId,
  sender,
  retryQuestion,
}: {
  message: ChatMessage;
  sessionId: string | null;
  sender?: string;
  retryQuestion?: string;
}): React.JSX.Element {
  if (message.role === 'user') {
    return (
      <div className="flex flex-col items-end">
        {sender && (
          <p className="mb-1 max-w-[min(85%,42rem)] truncate text-2xs text-ink-muted">
            {sender === 'You' ? (
              'You'
            ) : (
              <>
                <span className="sr-only-live">Sent by </span>
                <span className="font-mono">{sender}</span>
              </>
            )}
          </p>
        )}
        <div className="max-w-[min(85%,42rem)] rounded-2xl rounded-br-md bg-brand px-4 py-2.5 text-brand-fg shadow-xs">
          {/* Plain text with drawable structures (`StructureText`), not markdown: asterisks in a compound name are not emphasis. */}
          <p className="text-base whitespace-pre-wrap">
            <StructureText text={message.text} />
          </p>
        </div>
        {/* Put the question back in the composer and stop; the human presses Send. Never an automatic regenerate. */}
        <Button
          variant="ghost"
          size="xs"
          className="mt-1 text-ink-subtle"
          onClick={() => prefill(message.text)}
        >
          <Pencil aria-hidden className="size-3" />
          Edit and resend
        </Button>
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
      <AssistantBubble message={message} sessionId={sessionId} retryQuestion={retryQuestion} />
    </article>
  );
}

/** How many messages render before "Load earlier". */
const WINDOW_STEP = 60;

/**
 * Takes an id, not a conversation: the conversation object is replaced every animation frame, so
 * subscribing to the two fields needed keeps that churn inside the transcript.
 */
export function MessageList({ conversationId }: { conversationId: string }): React.JSX.Element {
  const all = useChatStore((s) => s.conversations[conversationId]?.messages);
  const sessionId = useChatStore((s) => s.conversations[conversationId]?.sessionId ?? null);
  const contextLost = useChatStore((s) => s.conversations[conversationId]?.contextLost ?? false);
  const member = useChatStore((s) => Boolean(s.conversations[conversationId]?.membership));
  const me = useChatStore((s) => s.viewer);
  // More than one person here, derived from the transcript so opening costs no roster request.
  const shared = useMemo(
    () =>
      member ||
      (all ?? []).some((m) => m.role === 'user' && m.author !== undefined && m.author !== me),
    [all, member, me],
  );

  // The rail's selected subject narrows this conversation's transcript, read from this
  // conversation's index.
  const selectedEntity = useEntityStore((s) => {
    const slice = entitiesOf(s, conversationId);
    return slice.selected ? slice.entities[slice.selected] : undefined;
  });

  const messages = useMemo(() => {
    if (!all || !selectedEntity) return all;
    const hits = messagesFor(selectedEntity);
    // The user message that *prompted* a matching assistant turn comes along with it: an answer
    // shown without the question it answers reads as the agent volunteering something.
    return all.filter((message, i) => {
      if (hits.has(message.id)) return true;
      const next = all[i + 1];
      return message.role === 'user' && next?.role === 'assistant' && hits.has(next.id);
    });
  }, [all, selectedEntity]);

  const endRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  /** Set by "Load earlier": which bubble the reader was looking at and where. */
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
    // Anchor on a real on-screen element rather than `scrollHeight` arithmetic: prepended bubbles
    // report estimated heights under `content-visibility`.
    const first = shown[0];
    const node = first ? el?.querySelector(`[data-message-id="${CSS.escape(first.id)}"]`) : null;
    anchorRef.current =
      node && el ? { id: first!.id, top: node.getBoundingClientRect().top } : null;
    setWindowSize((n) => n + WINDOW_STEP);
  };

  // Declared above the pin effect: layout effects run in order, and this must restore the offset
  // first.
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

  // Pin to the bottom while streaming, until the user scrolls up. An IntersectionObserver avoids
  // per-scroll geometry reads.
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

      {/* The card may be wide; the prose inside keeps the reading measure. */}
      <div className="mx-auto flex w-full max-w-wide flex-col gap-5">
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

        {total === 0 &&
          // A new conversation and a filter that matches nothing get different empty states.
          (selectedEntity ? (
            <EmptyState icon={<FlaskConical className="size-5" />} title="Nothing about that yet">
              No turn in this conversation mentions it. Clear the filter in the rail to see the
              whole transcript.
            </EmptyState>
          ) : (
            <EmptyState icon={<FlaskConical className="size-5" />} title="Chemclaw">
              Process &amp; analytical development assistant. Ask about a reaction, a property, or
              what to run next.
            </EmptyState>
          ))}

        {shown.map((message, i) => (
          <Bubble
            key={message.id}
            message={message}
            sessionId={sessionId}
            sender={senderOf(message, shared, me)}
            retryQuestion={retryQuestionOf(shown, i, shared, me)}
          />
        ))}
        <div ref={endRef} className="h-px" />
      </div>
    </div>
  );
}
