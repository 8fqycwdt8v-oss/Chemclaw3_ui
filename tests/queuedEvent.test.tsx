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

const QUEUED = { type: 'queued', ticket: null, position: null } as const;
const inLine = (ticket: number, position: number) =>
  ({ type: 'queued', ticket, position }) as const;

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
    expect(normalizeEvent({ type: 'queued' })).toEqual({
      type: 'queued',
      ticket: null,
      position: null,
    });
  });

  it('accepts it under the SSE event name alone', () => {
    // The backend sets both the `event:` name and the JSON `type`; a payload-less event is the
    // one case where losing the fallback would be easy to miss.
    expect(normalizeEvent({}, 'queued')).toEqual({ type: 'queued', ticket: null, position: null });
  });

  it('reads a place in a shared conversation’s line (Chemclaw3 #499)', () => {
    expect(normalizeEvent({ type: 'queued', ticket: 41, position: 2 })).toEqual({
      type: 'queued',
      ticket: 41,
      position: 2,
    });
  });

  it('reads a place it cannot use as no place, never as a wrong one', () => {
    // A negative or fractional place is a service getting it wrong. Read as `null` it is the
    // admission wait's reading — "waiting" — rather than a place in line nobody holds.
    expect(normalizeEvent({ type: 'queued', ticket: 'x', position: -1 })).toEqual({
      type: 'queued',
      ticket: null,
      position: null,
    });
    expect(normalizeEvent({ type: 'queued', ticket: 4.5, position: 1.5 })).toMatchObject({
      ticket: null,
      position: null,
    });
  });
});

describe('applyEvent', () => {
  it('marks the turn queued without adding a trace row', () => {
    const { cid, mid } = startTurn();
    useChatStore.getState().applyEvent(cid, mid, QUEUED);

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
    useChatStore.getState().applyEvent(cid, mid, QUEUED);

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
    store.applyEvent(cid, mid, QUEUED);
    store.applyEvent(cid, mid, { type: 'token', text: 'The pKa is 9.2.' });

    render(<MessageList conversationId={cid} />);
    expect(screen.queryByText(/waiting for a free slot/i)).toBeNull();
    expect(screen.getByText(/The pKa is 9.2./)).toBeTruthy();
  });
});

describe('a place in a shared conversation’s line', () => {
  it('records the ticket and the place, and not the admission flag', () => {
    const { cid, mid } = startTurn();
    useChatStore.getState().applyEvent(cid, mid, inLine(7, 1));

    const assistant = assistantOf(cid, mid);
    expect(assistant.queuePlace).toEqual({ ticket: 7, position: 1 });
    // The two waits stay apart: the admission notice says "the server is busy", which this is not.
    expect(assistant.queued).toBe(false);
    expect(assistant.trace).toHaveLength(0);
  });

  it('says where the message stands, and updates as the line moves', () => {
    const { cid, mid } = startTurn();
    useChatStore.getState().applyEvent(cid, mid, inLine(7, 2));
    const { rerender } = render(<MessageList conversationId={cid} />);
    expect(screen.getByText(/2 messages ahead of yours/)).toBeTruthy();

    useChatStore.getState().applyEvent(cid, mid, inLine(7, 0));
    rerender(<MessageList conversationId={cid} />);
    expect(screen.getByText(/next in line/i)).toBeTruthy();
    expect(screen.queryByText(/ahead of yours/)).toBeNull();
    expect(screen.queryByText(/waiting for a free slot/i)).toBeNull();
  });

  it('forgets the ticket the moment the turn starts', () => {
    // From the first event that is not a place, the turn is running: Stop must stop it, and a
    // withdrawal would answer 404. An admission wait after the line is the turn's, too.
    const { cid, mid } = startTurn();
    const store = useChatStore.getState();
    store.applyEvent(cid, mid, inLine(7, 0));
    store.applyEvent(cid, mid, QUEUED);
    expect(assistantOf(cid, mid).queuePlace).toBeNull();
    expect(assistantOf(cid, mid).queued).toBe(true);

    const second = startTurn();
    store.applyEvent(second.cid, second.mid, inLine(9, 0));
    store.applyEvent(second.cid, second.mid, { type: 'token', text: 'The pKa' });
    expect(assistantOf(second.cid, second.mid).queuePlace).toBeNull();
  });

  it('settles a withdrawn message without an error, saying why', () => {
    const { cid, mid } = startTurn();
    const store = useChatStore.getState();
    store.applyEvent(cid, mid, inLine(7, 0));
    store.withdrawTurn(cid, mid, 'The owner withdrew your message before it ran.');

    const assistant = assistantOf(cid, mid);
    expect(assistant.status).toBe('aborted');
    expect(assistant.error).toBeNull();
    expect(assistant.queuePlace).toBeNull();

    render(<MessageList conversationId={cid} />);
    expect(screen.getByText('The owner withdrew your message before it ran.')).toBeTruthy();
    // Not the copy for an answer cut short: there never was one.
    expect(screen.queryByText(/Stopped before the answer was complete/)).toBeNull();
  });
});
