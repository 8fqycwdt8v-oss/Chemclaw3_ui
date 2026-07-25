/**
 * The transcript.
 *
 * While a turn streams we render the accumulated tokens as plain pre-wrap text and only switch to
 * full markdown once the answer settles. Re-parsing markdown on every animation frame is both
 * expensive and visually unstable — an unbalanced code fence makes the whole answer flicker
 * between "code block" and "prose" as the closing backticks arrive.
 */

import { useEffect, useRef } from 'react';
import type { AssistantMessage, ChatMessage, Conversation } from '../state/types.ts';
import { Markdown } from './Markdown.tsx';
import { TracePanel } from './TracePanel.tsx';
import { AnswerFooter, ReviewRequiredPill } from './AnswerBadges.tsx';
import { ApprovalPrompt, QuestionPrompt } from './Prompts.tsx';
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

function AssistantBubble({ message }: { message: AssistantMessage }): React.JSX.Element {
  // finalText wins outright. answer.text is the full concatenation of every token, so anything
  // that combined the two would render the entire answer twice.
  const body = message.finalText ?? message.streamedText;
  const streaming = message.status === 'streaming';

  const question = message.trace.findLast?.((e) => e.kind === 'question')?.question;
  const approval = message.trace.findLast?.((e) => e.kind === 'approval_request')?.approval;

  return (
    <div className="max-w-none">
      <ReviewRequiredPill message={message} />
      {message.latestPlan && <PlanChecklist todos={message.latestPlan} />}

      {body ? (
        streaming ? (
          <div className="whitespace-pre-wrap text-[0.95rem] leading-relaxed">
            {body}
            <span className="caret">▌</span>
          </div>
        ) : (
          <Markdown>{body}</Markdown>
        )
      ) : (
        streaming && <p className="text-sm text-ink-muted">Thinking…</p>
      )}

      {message.status === 'aborted' && (
        <p className="mt-2 text-xs text-ink-muted">Stopped before the answer was complete.</p>
      )}

      {message.error && (
        <div className="mt-2 rounded-md border border-danger/40 bg-danger-soft px-3 py-2">
          <p className="text-sm text-danger">{message.error.message}</p>
        </div>
      )}

      {question && <QuestionPrompt question={question.question} options={question.options} />}
      {approval && (
        <ApprovalPrompt prompt={approval.prompt} approvalId={approval.approvalId} />
      )}

      <AnswerFooter message={message} />
      <TracePanel trace={message.trace} />
    </div>
  );
}

function Bubble({ message }: { message: ChatMessage }): React.JSX.Element {
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
      <AssistantBubble message={message} />
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

        {conversation.messages.map((message) => (
          <Bubble key={message.id} message={message} />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
