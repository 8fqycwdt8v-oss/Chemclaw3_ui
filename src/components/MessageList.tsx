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
import type { AssistantMessage, ChatMessage, TraceEntry } from '../state/types.ts';
import { Markdown } from './LazyMarkdown.tsx';
import { StructureText } from './Molecule.tsx';
import { TracePanel } from './TracePanel.tsx';
import { StatusStrip } from './StatusStrip.tsx';
import { PlanStrip } from './PlanStrip.tsx';
import { ActivityLine } from './ActivityLine.tsx';
import { ResultBlock } from './ResultBlock.tsx';
import { ApprovalPrompt, QuestionPrompt } from './Prompts.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { useChatStore } from '../state/chatStore.ts';
import { entitiesOf, messagesFor, useEntityStore } from '../chem/entities.ts';
import { returnedFigures } from '../chem/provenance.ts';
import { formatDuration } from '../state/turnActivity.ts';
import { EmptyState } from '@/components/chem/Feedback';
import { cn } from '@/lib/utils';

/**
 * How many stored results are rendered as blocks under one answer.
 *
 * A cap rather than all of them, because each block is a fetch the reader did not ask for. Three
 * covers the shape of nearly every turn — a screen, a lookup and a search — and the rest stay one
 * click away on their own step in the agent's work, which is where a fourth table would have to be
 * looked for anyway.
 */
const MAX_RESULT_BLOCKS = 3;

/**
 * The rail's closing row: the answer as a step of the turn.
 *
 * The service announces every step except the one that produced the text, so a rail without this
 * stops at the last tool call — and a reader looking at where a four-minute turn went cannot see
 * that three of those minutes were the model writing.
 *
 * Words rather than tokens, because nothing on this side knows how the service tokenised anything,
 * and the duration runs from the last step that WAS announced to the turn's end. Absent while the
 * turn streams, and absent for a turn that produced no text at all — a row claiming an answer
 * where the card says "the turn finished without producing any answer text" would be the two
 * halves of one screen disagreeing.
 *
 * Exported for its own test. The arithmetic is the whole of it and it is not visible in the
 * markup — a duration measured from the wrong instant renders as a perfectly plausible number.
 */
export function answerStep(message: AssistantMessage): { words: number; duration?: string } | null {
  if (message.status === 'streaming') return null;
  const text = message.finalText || message.streamedText;
  if (!text.trim()) return null;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  // The last instant the trace knows about, which is NOT the last row's `at`: a `tool_call` row is
  // stamped when the call was *issued* and its result closes that same row in place, so measuring
  // from `at` charges the whole of the last tool's runtime to the answer — and the rail's rows
  // then sum to more than the turn took.
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
 * The turn's results, as data, under the answer.
 *
 * A call qualifies when its result is *reachable*, and there are two ways to be reachable: the
 * service stored it (a `resultRef` to fetch) or it rode along on the event (`resultInline`). They
 * are independent — the inline cap and the store cap are different settings, and a deployment with
 * the store switched off still inlines its small results — so testing only the ref dropped every
 * block in exactly the deployment where no fetch was needed at all.
 *
 * A session id is still required for the fetching half, because that route is session-scoped: a
 * transcript rehydrated from the server has the calls and nothing to fetch against.
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
          toolCall: { tool: string; resultRef?: string; resultInline?: string };
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
  //
  // `||` and not `??`, which falls back only on null/undefined. A terminal `answer` carrying
  // `text: ''` — a shape the service really sends — then replaced a settled answer with the empty
  // string and the ternary below rendered nothing whatsoever, erasing tokens the reader had just
  // watched arrive. Falling back to them is not the forbidden combination: it never concatenates.
  const body = message.finalText || message.streamedText;
  const streaming = message.status === 'streaming';

  const question = message.trace.findLast?.((e) => e.kind === 'question')?.question;
  const approval = message.trace.findLast?.((e) => e.kind === 'approval_request')?.approval;

  // Recomputed only when the trace grows, so the answer is not re-parsed on every token of the
  // *next* turn. Empty on a turn whose tools returned no numbers, which is what switches the
  // grounding overlay off rather than flagging every figure in it.
  const figures = useMemo(() => returnedFigures(message.trace), [message.trace]);

  return (
    <div className="flex flex-col" aria-busy={streaming || undefined}>
      {/* Everything that qualifies the answer, ranked: a bar for what stops the reader acting on
          it, a chip for what they consult. Above the text, because a qualifier placed after it is
          read once the reader has already believed it. */}
      <div className="max-w-prose">
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
          // A settled turn with nothing in either field says so. An empty card is
          // indistinguishable from a service that answered nothing — and from this component
          // having lost the answer, which is exactly what it used to do. The question and approval
          // cards are content in their own right, so a turn that ended in one is not "no answer".
          // While it streams, the activity row above is the whole of what there is to say.
          message.status === 'done' &&
          !question &&
          !approval && (
            <p className="text-sm text-ink-muted">
              The turn finished without producing any answer text.
            </p>
          )
        )}
      </div>

      {/* What the tools returned, as the tables they are, at the same depth as the sentence that
          refers to them. A wide one takes the card's full width; the prose above stays measured. */}
      <ResultBlocks trace={message.trace} sessionId={sessionId} />

      <div className="max-w-prose">
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
            // Stable identities: both come off the store's message and are replaced only by a new
            // `plan` event, so passing them straight through does not re-run the card's effect.
            planTodos={message.latestPlan}
            planHash={message.latestPlanHash}
          />
        )}
      </div>

      <TracePanel
        trace={message.trace}
        sessionId={sessionId}
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
        <div className="max-w-[min(85%,42rem)] rounded-2xl rounded-br-md bg-brand px-4 py-2.5 text-brand-fg shadow-xs">
          {/* Plain text, with its structures drawable — see `StructureText`. Not markdown: a
              chemist typed this, and a parser would turn their asterisks into emphasis in the
              middle of a compound name. */}
          <p className="text-base whitespace-pre-wrap">
            <StructureText text={message.text} />
          </p>
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
  const all = useChatStore((s) => s.conversations[conversationId]?.messages);
  const sessionId = useChatStore((s) => s.conversations[conversationId]?.sessionId ?? null);
  const contextLost = useChatStore((s) => s.conversations[conversationId]?.contextLost ?? false);

  // Selecting a subject in the rail narrows the transcript to the turns that mention it. Read from
  // THIS conversation's index, named by the same route parameter the rail is: a global `selected`
  // matched one conversation's message ids against another's mentions, matched nothing, and left
  // an empty transcript over a conversation full of turns.
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

      {/* The card is allowed the wide measure; the prose inside it is held to the reading one.
            That split is what gives a charge table or a grid of structures somewhere to be —
            below `wide` the two collapse and the transcript is exactly as it was. */}
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
          // Two different nothings. A conversation with no turns is a new conversation; a
          // conversation whose turns are all filtered out is a *filter* result, and saying
          // "ask about a reaction" over a transcript full of turns is the failure the
          // per-conversation index was introduced to stop.
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

        {shown.map((message) => (
          <Bubble key={message.id} message={message} sessionId={sessionId} />
        ))}
        <div ref={endRef} className="h-px" />
      </div>
    </div>
  );
}
