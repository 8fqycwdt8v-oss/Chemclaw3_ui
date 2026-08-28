/**
 * A turn parked on admission control says so, instead of claiming to be thinking.
 *
 * The backend used to take its admission permit before the response existed, so a turn waiting
 * for capacity produced no bytes at all and then a bare HTTP 503 (backend D-166). It now opens the
 * stream first and sends `queued`. That event only ever arrives for a turn that genuinely had to
 * wait, which is why the interesting assertions here are as much about its *absence*: an ordinary
 * turn must not render a queue state, and this must not become a trace row for a turn that has not
 * yet done anything.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { normalizeEvent } from '../shared/events.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import { MessageList } from '../src/components/MessageList.tsx';
import type { AssistantMessage } from '../src/state/types.ts';

const assistantOf = (conversationId: string, messageId: string): AssistantMessage => {
  const message = useChatStore
    .getState()
    .conversations[conversationId]?.messages.find((m) => m.id === messageId);
  if (!message || message.role !== 'assistant') throw new Error('no assistant message');
  return message;
};

const startTurn = (): { cid: string; mid: string } => {
  const store = useChatStore.getState();
  const cid = store.createConversation();
  return { cid, mid: store.startAssistantMessage(cid) };
};

beforeEach(() => {
  cleanup();
  useChatStore.setState({
    conversations: {},
    order: [],
    activeId: null,
    composerLock: false,
    banner: null,
    jobFeed: [],
    streaming: null,
  });
});

describe('normalizeEvent', () => {
  it('accepts queued', () => {
    expect(normalizeEvent({ type: 'queued' })).toEqual({ type: 'queued' });
  });

  it('accepts it under the SSE event name alone', () => {
    // The backend sets both the `event:` name and the JSON `type`; a payload-less event is the
    // one case where losing the fallback would be easy to miss.
    expect(normalizeEvent({}, 'queued')).toEqual({ type: 'queued' });
  });
});

describe('applyEvent', () => {
  it('marks the turn queued without adding a trace row', () => {
    const { cid, mid } = startTurn();
    useChatStore.getState().applyEvent(cid, mid, { type: 'queued' });

    const assistant = assistantOf(cid, mid);
    expect(assistant.queued).toBe(true);
    // Nothing has happened yet — a trace row would describe a step that does not exist.
    expect(assistant.trace).toHaveLength(0);
  });

  it('leaves an ordinary turn unqueued', () => {
    const { cid, mid } = startTurn();
    useChatStore.getState().applyEvent(cid, mid, { type: 'token', text: 'pKa is ' });
    expect(assistantOf(cid, mid).queued).toBe(false);
  });
});

describe('the streaming placeholder', () => {
  it('says the turn is waiting for the server, not thinking', () => {
    const { cid, mid } = startTurn();
    useChatStore.getState().applyEvent(cid, mid, { type: 'queued' });

    render(<MessageList conversationId={cid} />);
    expect(screen.getByText(/waiting for a free slot/i)).toBeTruthy();
    expect(screen.queryByText('Thinking')).toBeNull();
  });

  it('says "Thinking" when the turn was admitted straight away', () => {
    const { cid } = startTurn();

    render(<MessageList conversationId={cid} />);
    expect(screen.getByText('Thinking')).toBeTruthy();
    expect(screen.queryByText(/waiting for a free slot/i)).toBeNull();
  });

  it('drops the notice as soon as the first token arrives', () => {
    // The waiting state needs no clearing: once there is text to show, the placeholder that
    // carried it is not rendered at all. This pins that, because a stale "waiting" line beside a
    // streaming answer would be worse than the "Thinking" it replaced.
    const { cid, mid } = startTurn();
    const store = useChatStore.getState();
    store.applyEvent(cid, mid, { type: 'queued' });
    store.applyEvent(cid, mid, { type: 'token', text: 'The pKa is 9.2.' });

    render(<MessageList conversationId={cid} />);
    expect(screen.queryByText(/waiting for a free slot/i)).toBeNull();
    expect(screen.getByText(/The pKa is 9.2./)).toBeTruthy();
  });
});
