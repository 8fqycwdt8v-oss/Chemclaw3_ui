/**
 * The transcript.
 *
 * While a turn streams we render the accumulated tokens as plain pre-wrap text and only switch to
 * full markdown once the answer settles. Re-parsing markdown on every animation frame is both
 * expensive and visually unstable — an unbalanced code fence makes the whole answer flicker
 * between "code block" and "prose" as the closing backticks arrive.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { AssistantMessage, ChatMessage, Conversation, TurnError } from '../state/types.ts';
import { messagesFor, useEntityStore } from '../chem/entities.ts';
import { returnedFigures } from '../chem/provenance.ts';
import { returnedNoteIds } from '../lib/citations.ts';
import { Markdown } from './Markdown.tsx';
import { TracePanel } from './TracePanel.tsx';
import { AnswerFooter, CapabilityDegradedPill, ReviewRequiredPill } from './AnswerBadges.tsx';
import { ApprovalPrompt, QuestionPrompt } from './Prompts.tsx';
import { errorNextStep } from '../lib/format.ts';
import { cn } from '../lib/cn.ts';

function PlanChecklist({ todos }: { todos: string[] }): React.JSX.Element | null {
  if (todos.length === 0) return null;
  return (
    <div className="mb-2 rounded-md border border-border-subtle bg-surface-sunken px-3 py-2">
      <p className="mb-1 text-xs font-medium text-ink-muted">Plan</p>
      <ul className="space-y-0.5">
        {todos.map((todo, i) => (
          <li key={i} className="text-sm">
            <span className="mr-1.5 text-ink-muted">▢</span>
            {todo}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A failed turn, with what to do about it.
 *
 * The three typed fields were all on the wire and none reached the screen: only `message` was
 * rendered, so a turn that wrote nothing, a turn that blew its budget and a turn whose database was
 * down produced one undifferentiated red box and no next step.
 *
 * The correlation id is shown in full, and is not the session id. It is the key the audit trail is
 * keyed on — the one thing an operator needs to find the turn — and the backend states outright
 * that it is not sensitive (a random per-turn hex string). Hiding it costs a bug report its only
 * useful contents.
 */
function TurnErrorCard({ error }: { error: TurnError }): React.JSX.Element {
  const nextStep = errorNextStep(error.code, error.retryable);
  return (
    <div className="mt-2 rounded-md border border-danger/40 bg-danger-soft px-3 py-2">
      <p className="text-sm text-danger">{error.message}</p>
      {nextStep && <p className="mt-1.5 text-sm text-danger">{nextStep}</p>}
      {error.correlationId && (
        <p className="mt-1.5 text-xs text-danger">
          Quote this if you report it:{' '}
          <span className="font-mono select-all">{error.correlationId}</span>
        </p>
      )}
    </div>
  );
}

function AssistantBubble({
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

  // Recomputed only when the trace grows, so the answer is not re-parsed on every token of the
  // *next* turn. Empty on a turn whose tools returned no numbers, which is what switches the
  // grounding overlay off rather than flagging every figure in it.
  const figures = useMemo(() => returnedFigures(message.trace), [message.trace]);
  // The same thread, one field over: the ids the turn's tools really returned, which the citation
  // plugin uses in place of guessing at note-shaped tokens in the prose. Empty on a turn with no
  // tool results — and on any backend that predates the field — which is what keeps the guess as
  // the fallback rather than making it the only mode.
  const citedNotes = useMemo(() => returnedNoteIds(message.trace), [message.trace]);

  return (
    <div className="max-w-none">
      <CapabilityDegradedPill message={message} />
      <ReviewRequiredPill message={message} />
      {message.latestPlan && <PlanChecklist todos={message.latestPlan} />}

      {body ? (
        streaming ? (
          <div className="whitespace-pre-wrap text-[0.95rem] leading-relaxed">
            {body}
            <span className="caret">▌</span>
          </div>
        ) : (
          <Markdown figures={figures} noteIds={citedNotes}>
            {body}
          </Markdown>
        )
      ) : (
        streaming && (
          <p className="text-sm text-ink-muted">
            {/* "Thinking…" is untrue while the turn is parked on admission control: nothing is
                running yet. The distinction is the point of the event — a queued turn and a hung
                server used to look identical from here. */}
            {message.queued ? 'Waiting for a free slot on the server…' : 'Thinking…'}
          </p>
        )
      )}

      {message.status === 'aborted' && (
        <p className="mt-2 text-xs text-ink-muted">Stopped before the answer was complete.</p>
      )}

      {message.error && <TurnErrorCard error={message.error} />}

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
}

function Bubble({
  message,
  sessionId,
}: {
  message: ChatMessage;
  sessionId: string | null;
}): React.JSX.Element {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-accent px-4 py-2 text-white">
          <p className="whitespace-pre-wrap text-[0.95rem]">{message.text}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-2xl rounded-bl-sm border border-border-subtle bg-surface-raised px-4 py-3">
      <AssistantBubble message={message} sessionId={sessionId} />
    </div>
  );
}

export function MessageList({
  conversation,
}: {
  conversation: Conversation;
}): React.JSX.Element {
  const endRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Keep the view pinned to the bottom while streaming, but stop fighting the user the moment
  // they scroll up to read something earlier.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = (): void => {
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Selecting an entity in the rail narrows the transcript to the turns that mention it. The user
  // message that *prompted* a matching assistant turn comes along with it: an answer shown without
  // the question it answers reads as the agent volunteering something.
  const selected = useEntityStore((s) => s.selected);
  const selectedEntity = useEntityStore((s) => (s.selected ? s.entities[s.selected] : undefined));

  const filtered = useMemo(() => {
    if (!selected) return conversation.messages;
    const hits = messagesFor(selectedEntity);
    return conversation.messages.filter((message, i) => {
      if (hits.has(message.id)) return true;
      const next = conversation.messages[i + 1];
      return message.role === 'user' && next?.role === 'assistant' && hits.has(next.id);
    });
  }, [conversation.messages, selected, selectedEntity]);

  const lastMessage = conversation.messages.at(-1);
  const streamedLength =
    lastMessage?.role === 'assistant'
      ? (lastMessage.finalText ?? lastMessage.streamedText).length
      : 0;

  useEffect(() => {
    if (pinnedRef.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [conversation.messages.length, streamedLength]);

  return (
    <div ref={scrollerRef} className="flex-1 overflow-y-auto px-4 py-6">
      <div className={cn('mx-auto flex max-w-3xl flex-col gap-4')}>
        {conversation.contextLost && (
          <div className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2">
            <p className="text-sm text-warn">
              This conversation’s server session was replaced. The assistant no longer remembers
              the turns above — restate anything it needs.
            </p>
          </div>
        )}

        {conversation.messages.length === 0 && (
          <div className="py-16 text-center">
            <h2 className="text-lg font-medium">Chemclaw</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Process &amp; analytical development assistant. Ask about a reaction, a property, or
              what to run next.
            </p>
          </div>
        )}

        {filtered.length === 0 && conversation.messages.length > 0 && (
          <p className="py-8 text-center text-sm text-ink-muted">
            No turn in this conversation mentions that yet.
          </p>
        )}

        {filtered.map((message) => (
          <Bubble key={message.id} message={message} sessionId={conversation.sessionId} />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
