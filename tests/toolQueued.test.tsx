/**
 * A tool call waiting for a compute slot says so, instead of claiming to be running.
 *
 * Core #495/#502 routes heavy connector tools through a global queue
 * (`D-2026-09-30-a-heavy-tool-call-waits-in-a-queue-rather-than-being-refused`) and sends
 * `tool_queued` while a call waits — once after the first poll, again when the waiting count moves,
 * once when a worker picks it up. Before this file the event was dropped at the gate and the card
 * read "running…" for the whole wait.
 *
 * Kept apart, in every assertion that could blur them, from the `queued` event: that one is a
 * *message* waiting (admission, or a place in a shared session's line — `queuedEvent.test.tsx`);
 * this is one *tool call* waiting inside a turn that is already running.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { normalizeEvent, type ToolQueuedEvent } from '../shared/events.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import { TracePanel } from '../src/components/TracePanel.tsx';
import { ActivityRow } from '../src/components/ActivityLine.tsx';
import { registerAnnouncer } from '../src/state/announce.ts';
import { computeBacklog, turnActivity } from '../src/state/turnActivity.ts';
import type { AssistantMessage } from '../src/state/types.ts';

const TOOL = 'compute_xtb_energy';

const waiting = (n: number | null, jobId = 'q-1'): ToolQueuedEvent => ({
  type: 'tool_queued',
  tool: TOOL,
  job_id: jobId,
  state: 'queued',
  waiting: n,
});
const pickedUp = (jobId = 'q-1'): ToolQueuedEvent => ({
  type: 'tool_queued',
  tool: TOOL,
  job_id: jobId,
  state: 'running',
  waiting: null,
});

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
  const mid = store.startAssistantMessage(cid);
  store.applyEvent(cid, mid, { type: 'tool_call', tool: TOOL, arguments: '{"smiles":"CCO"}' });
  return { cid, mid };
};

const callsOf = (cid: string, mid: string) =>
  assistantOf(cid, mid)
    .trace.filter((e) => e.kind === 'tool_call')
    .map((e) => e.toolCall);

let heard: string[];
let unregister: (() => void) | null = null;

beforeEach(() => {
  cleanup();
  heard = [];
  unregister = registerAnnouncer((message) => heard.push(message));
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

afterEach(() => {
  unregister?.();
  unregister = null;
  cleanup();
});

describe('normalizeEvent', () => {
  it('admits tool_queued with every field it carries', () => {
    expect(
      normalizeEvent({
        type: 'tool_queued',
        tool: TOOL,
        job_id: 'q-1',
        state: 'queued',
        waiting: 3,
      }),
    ).toEqual({ type: 'tool_queued', tool: TOOL, job_id: 'q-1', state: 'queued', waiting: 3 });
  });

  it('reads a backlog the broker could not give as null, not as zero', () => {
    expect(
      normalizeEvent({ type: 'tool_queued', tool: TOOL, job_id: 'q', state: 'running' }),
    ).toEqual({ type: 'tool_queued', tool: TOOL, job_id: 'q', state: 'running', waiting: null });
  });

  it('reads a count it cannot use as no count, and a state it does not know as running', () => {
    // `running` is what an open card already claims, so an unheard-of state adds no claim.
    expect(
      normalizeEvent({
        type: 'tool_queued',
        tool: TOOL,
        job_id: 'q',
        state: 'paused',
        waiting: -2,
      }),
    ).toMatchObject({ state: 'running', waiting: null });
    expect(normalizeEvent({ type: 'tool_queued', waiting: 2.5 })).toMatchObject({ waiting: null });
  });

  it('is a different member from the message queue’s `queued`', () => {
    expect(normalizeEvent({}, 'tool_queued')?.type).toBe('tool_queued');
    expect(normalizeEvent({ type: 'queued', ticket: 1, position: 0 })?.type).toBe('queued');
  });
});

describe('applyEvent', () => {
  it('annotates the open card for the same tool without adding a row', () => {
    const { cid, mid } = startTurn();
    useChatStore.getState().applyEvent(cid, mid, waiting(4));

    const message = assistantOf(cid, mid);
    expect(message.trace).toHaveLength(1);
    expect(message.trace[0]?.toolCall?.computeWait).toEqual({
      state: 'queued',
      waiting: 4,
      jobId: 'q-1',
    });
    // The message queue is untouched: the turn was admitted and is running.
    expect(message.queued).toBe(false);
    expect(message.queuePlace).toBeUndefined();
  });

  it('follows the count, then the pick-up, then clears on the result', () => {
    const { cid, mid } = startTurn();
    const store = useChatStore.getState();
    store.applyEvent(cid, mid, waiting(4));
    store.applyEvent(cid, mid, waiting(2));
    expect(callsOf(cid, mid)[0]?.computeWait).toMatchObject({ state: 'queued', waiting: 2 });

    store.applyEvent(cid, mid, pickedUp());
    expect(callsOf(cid, mid)[0]?.computeWait).toMatchObject({ state: 'running' });

    store.applyEvent(cid, mid, {
      type: 'tool_result',
      tool: TOOL,
      preview: '-154.2',
      result_ref: '',
      note_ids: [],
      numbers: [],
    });
    const [call] = callsOf(cid, mid);
    expect(call?.result).toBe('-154.2');
    expect(call?.computeWait).toBeUndefined();
  });

  it('clears on a failure too', () => {
    const { cid, mid } = startTurn();
    const store = useChatStore.getState();
    store.applyEvent(cid, mid, waiting(1));
    store.applyEvent(cid, mid, { type: 'tool_failed', tool: TOOL, message: 'refused' });
    expect(callsOf(cid, mid)[0]?.computeWait).toBeUndefined();
  });

  it('keeps a repeat on the card its job id already annotates', () => {
    const { cid, mid } = startTurn();
    const store = useChatStore.getState();
    store.applyEvent(cid, mid, { type: 'tool_call', tool: TOOL, arguments: '{"smiles":"CCN"}' });
    store.applyEvent(cid, mid, waiting(5, 'first'));
    store.applyEvent(cid, mid, waiting(6, 'second'));
    store.applyEvent(cid, mid, pickedUp('second'));

    const [first, second] = callsOf(cid, mid);
    expect(first?.computeWait).toMatchObject({ jobId: 'first', state: 'queued', waiting: 5 });
    expect(second?.computeWait).toMatchObject({ jobId: 'second', state: 'running' });
  });

  it('discards an event with no open card to annotate', () => {
    const { cid, mid } = startTurn();
    const store = useChatStore.getState();
    store.applyEvent(cid, mid, {
      type: 'tool_result',
      tool: TOOL,
      preview: 'done',
      result_ref: '',
      note_ids: [],
      numbers: [],
    });
    const before = assistantOf(cid, mid).trace;
    store.applyEvent(cid, mid, waiting(2));
    store.applyEvent(cid, mid, { ...waiting(2), tool: 'another_tool' });
    expect(assistantOf(cid, mid).trace).toEqual(before);
  });
});

describe('the wording', () => {
  it('words the backlog as approximate, and says nothing for null or zero', () => {
    expect(computeBacklog(3)).toBe('about 3 calls waiting');
    expect(computeBacklog(1)).toBe('about 1 call waiting');
    expect(computeBacklog(0)).toBe('');
    expect(computeBacklog(null)).toBe('');
  });
});

describe('the card', () => {
  const openPanel = (cid: string, mid: string) => {
    const view = render(<TracePanel trace={assistantOf(cid, mid).trace} />);
    fireEvent.click(screen.getByRole('button'));
    return view;
  };

  it('says waiting for a compute slot with the approximate backlog, not running', () => {
    const { cid, mid } = startTurn();
    useChatStore.getState().applyEvent(cid, mid, waiting(3));
    openPanel(cid, mid);

    expect(screen.getByText(/waiting for a compute slot · about 3 calls waiting/i)).toBeTruthy();
    expect(screen.queryByText('running…')).toBeNull();
    // Not the message queue's words.
    expect(screen.queryByText(/in line|free slot/i)).toBeNull();
  });

  it('says running once a worker has picked the call up', () => {
    const { cid, mid } = startTurn();
    const store = useChatStore.getState();
    store.applyEvent(cid, mid, waiting(3));
    store.applyEvent(cid, mid, pickedUp());
    openPanel(cid, mid);

    expect(screen.getByText('running…')).toBeTruthy();
    expect(screen.queryByText(/compute slot/i)).toBeNull();
  });

  it('carries no live region of its own — the count ticks silently', () => {
    const { cid, mid } = startTurn();
    useChatStore.getState().applyEvent(cid, mid, waiting(3));
    const { container } = openPanel(cid, mid);
    expect(container.querySelector('[aria-live]')).toBeNull();
  });
});

describe('the activity row and what a screen reader hears', () => {
  it('announces waiting → running once each, and not on a count tick', () => {
    const { cid, mid } = startTurn();
    const store = useChatStore.getState();
    const { rerender } = render(<ActivityRow message={assistantOf(cid, mid)} />);
    expect(heard).toEqual([`Calling ${TOOL}.`]);

    store.applyEvent(cid, mid, waiting(4));
    rerender(<ActivityRow message={assistantOf(cid, mid)} />);
    expect(screen.getByText(/Waiting for a compute slot · about 4 calls waiting/)).toBeTruthy();
    expect(turnActivity(assistantOf(cid, mid)).tone).toBe('waiting');

    store.applyEvent(cid, mid, waiting(2));
    rerender(<ActivityRow message={assistantOf(cid, mid)} />);
    expect(screen.getByText(/about 2 calls waiting/)).toBeTruthy();

    store.applyEvent(cid, mid, pickedUp());
    rerender(<ActivityRow message={assistantOf(cid, mid)} />);

    expect(heard).toEqual([
      `Calling ${TOOL}.`,
      `${TOOL} is waiting for a compute slot.`,
      `Calling ${TOOL}.`,
    ]);
  });
});
