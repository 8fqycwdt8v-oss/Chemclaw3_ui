/**
 * The banner's Retry, on the failures it was actually added for.
 *
 * `sendMessage` sets `action: 'retry'` for the retryable kinds — 503 `capacity` and the BFF's own
 * 502 mapped to `network` — and `TopBar` renders a button for it. But the only handler wired to
 * that button re-ran the *remote transcript read*, which is guarded on the conversation having no
 * messages. After a turn that guard is always false, so the button cleared the error and resent
 * nothing: the chemist's message was already gone from the composer and there was no way back to
 * it. The transcript-read failure is the other producer of the same action and must still work.
 *
 * What is pinned here is that a retryable failed turn is actually re-sent, and that the failed
 * pair is replaced rather than duplicated — a retry that appended a second copy of the question
 * would be its own bug.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '../src/state/chatStore.ts';

const conversationId = () => useChatStore.getState().order[0]!;

const messagesOf = (id: string) => useChatStore.getState().conversations[id]?.messages ?? [];

beforeEach(() => {
  useChatStore.getState().clearAll();
  useChatStore.getState().createConversation();
});

describe('prepareRetry', () => {
  it('pops a failed turn and hands back the question that produced it', () => {
    const id = conversationId();
    useChatStore.getState().appendUserMessage(id, 'What is the pKa?');
    const messageId = useChatStore.getState().startAssistantMessage(id);
    useChatStore.getState().failTurn(id, messageId, {
      kind: 'capacity',
      message: 'at capacity',
    });

    expect(messagesOf(id)).toHaveLength(2);
    expect(useChatStore.getState().prepareRetry(id)).toBe('What is the pKa?');
    // Both halves come off, so the resend re-appends them rather than duplicating the question.
    expect(messagesOf(id)).toHaveLength(0);
  });

  it('refuses a turn that is still streaming', () => {
    const id = conversationId();
    useChatStore.getState().appendUserMessage(id, 'What is the pKa?');
    useChatStore.getState().startAssistantMessage(id);

    expect(useChatStore.getState().prepareRetry(id)).toBeNull();
    expect(messagesOf(id)).toHaveLength(2);
  });

  it('refuses an empty conversation, so the transcript read stays the fallback', () => {
    expect(useChatStore.getState().prepareRetry(conversationId())).toBeNull();
  });

  it('leaves the transcript untouched when it refuses', () => {
    const id = conversationId();
    useChatStore.getState().appendUserMessage(id, 'only a question');

    expect(useChatStore.getState().prepareRetry(id)).toBeNull();
    expect(messagesOf(id)).toHaveLength(1);
  });
});
