/**
 * `hydrateTranscript` refusing to overwrite a conversation that is no longer empty.
 *
 * The caller checks emptiness before starting the read, but the read is a network round trip. A
 * user who typed and sent during that window had their message — and the answer streaming into it
 * — replaced by the server's older transcript when it landed. The caller's guard cannot see a
 * change that happens after it runs; only the write itself can.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '../src/state/chatStore.ts';
import type { ChatMessage } from '../src/state/types.ts';

const remote: ChatMessage[] = [
  { id: 'h0', role: 'user', text: 'an older question', at: 1 },
  { id: 'h1', role: 'user', text: 'and another', at: 2 },
];

const conversationId = () => useChatStore.getState().order[0]!;
const messagesOf = (id: string) => useChatStore.getState().conversations[id]?.messages ?? [];

beforeEach(() => {
  useChatStore.getState().clearAll();
  useChatStore.getState().createConversation();
});

describe('hydrateTranscript', () => {
  it('fills an empty conversation', () => {
    const id = conversationId();
    useChatStore.getState().hydrateTranscript(id, remote);

    expect(messagesOf(id)).toHaveLength(2);
  });

  it('does not discard a message sent while the read was in flight', () => {
    const id = conversationId();
    useChatStore.getState().appendUserMessage(id, 'what the chemist just asked');
    useChatStore.getState().startAssistantMessage(id);

    // The read started when the conversation was empty and lands now.
    useChatStore.getState().hydrateTranscript(id, remote);

    const messages = messagesOf(id);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', text: 'what the chemist just asked' });
  });

  it('ignores an empty read, so a blank conversation is not blanked again', () => {
    const id = conversationId();
    useChatStore.getState().appendUserMessage(id, 'still here');

    useChatStore.getState().hydrateTranscript(id, []);

    expect(messagesOf(id)).toHaveLength(1);
  });
});
