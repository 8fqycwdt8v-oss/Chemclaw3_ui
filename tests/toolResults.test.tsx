/**
 * A tool call and what it returned are one step, not two.
 *
 * The backend now announces a call when it is *issued* and sends `tool_result` when it comes back
 * (D-159). Both halves matter here: the row appears while the call is still running, which is the
 * dead-air window the whole change exists to make visible, and it is completed in place rather
 * than by a second row a reader has to pair up by eye.
 *
 * The case worth pinning hardest is the failure: a raised call never gets a `tool_result`, so a
 * row that only ever closes on success would claim a failed call is still running for the rest of
 * the conversation.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { normalizeEvent } from '../shared/events.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import { TracePanel } from '../src/components/TracePanel.tsx';
import type { AssistantMessage, TraceEntry } from '../src/state/types.ts';

const assistantOf = (conversationId: string, messageId: string): AssistantMessage => {
  const message = useChatStore
    .getState()
    .conversations[conversationId]?.messages.find((m) => m.id === messageId);
  if (!message || message.role !== 'assistant') throw new Error('no assistant message');
  return message;
};

/** A fresh conversation with one assistant message, returned as the ids the store keys on. */
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
  it('accepts tool_result', () => {
    expect(
      normalizeEvent({ type: 'tool_result', tool: 'predict_pka', preview: 'pKa 9.2' }),
    ).toEqual({ type: 'tool_result', tool: 'predict_pka', preview: 'pKa 9.2' });
  });

  it('coerces a malformed frame rather than dropping the event', () => {
    // The preview crosses a process boundary; a bad field should cost the value, not the event.
    expect(normalizeEvent({ type: 'tool_result', tool: 7, preview: null })).toEqual({
      type: 'tool_result',
      tool: 'unknown',
      preview: '',
    });
  });
});

describe('tool_result in the trace', () => {
  it('completes the call it answers instead of adding a row', () => {
    const { cid, mid } = startTurn();
    const store = useChatStore.getState();
    store.applyEvent(cid, mid, {
      type: 'tool_call',
      tool: 'predict_pka',
      arguments: '{"s":"CCO"}',
    });
    store.applyEvent(cid, mid, { type: 'tool_result', tool: 'predict_pka', preview: 'pKa 15.9' });

    const trace = assistantOf(cid, mid).trace;
    expect(trace).toHaveLength(1);
    expect(trace[0]?.toolCall).toEqual({
      tool: 'predict_pka',
      arguments: '{"s":"CCO"}',
      result: 'pKa 15.9',
    });
  });

  it('leaves an unanswered call open, which is what "running" means', () => {
    const { cid, mid } = startTurn();
    useChatStore
      .getState()
      .applyEvent(cid, mid, { type: 'tool_call', tool: 'submit_qm_job', arguments: '' });

    expect(assistantOf(cid, mid).trace[0]?.toolCall?.result).toBeUndefined();
  });

  it('pairs concurrent calls to one tool in the order they were issued', () => {
    const { cid, mid } = startTurn();
    const store = useChatStore.getState();
    store.applyEvent(cid, mid, { type: 'tool_call', tool: 'predict_pka', arguments: 'first' });
    store.applyEvent(cid, mid, { type: 'tool_call', tool: 'predict_pka', arguments: 'second' });
    store.applyEvent(cid, mid, { type: 'tool_result', tool: 'predict_pka', preview: 'A' });
    store.applyEvent(cid, mid, { type: 'tool_result', tool: 'predict_pka', preview: 'B' });

    const trace = assistantOf(cid, mid).trace;
    expect(trace.map((e) => e.toolCall?.result)).toEqual(['A', 'B']);
  });

  it('discards a result whose call is not in the trace', () => {
    const { cid, mid } = startTurn();
    useChatStore
      .getState()
      .applyEvent(cid, mid, { type: 'tool_result', tool: 'predict_pka', preview: 'orphan' });

    expect(assistantOf(cid, mid).trace).toHaveLength(0);
  });
});

describe('tool_failed', () => {
  it('closes its call and still reports the reason on its own row', () => {
    const { cid, mid } = startTurn();
    const store = useChatStore.getState();
    store.applyEvent(cid, mid, { type: 'tool_call', tool: 'predict_pka', arguments: '' });
    store.applyEvent(cid, mid, {
      type: 'tool_failed',
      tool: 'predict_pka',
      message: 'connector timed out',
    });

    const trace = assistantOf(cid, mid).trace;
    // Closed, so the call stops claiming to be running — but not "returned": it never did.
    expect(trace[0]?.toolCall?.failed).toBe(true);
    expect(trace[0]?.toolCall?.result).toBeUndefined();
    expect(trace[1]?.toolFailure?.message).toBe('connector timed out');
  });

  it('does not close a different tool that is still running', () => {
    const { cid, mid } = startTurn();
    const store = useChatStore.getState();
    store.applyEvent(cid, mid, { type: 'tool_call', tool: 'submit_qm_job', arguments: '' });
    store.applyEvent(cid, mid, { type: 'tool_failed', tool: 'predict_pka', message: 'nope' });

    expect(assistantOf(cid, mid).trace[0]?.toolCall?.failed).toBeUndefined();
  });
});

describe('TracePanel', () => {
  const open = (trace: TraceEntry[]): void => {
    render(<TracePanel trace={trace} />);
    fireEvent.click(screen.getByRole('button'));
  };

  const call = (toolCall: NonNullable<TraceEntry['toolCall']>): TraceEntry => ({
    id: 't1',
    at: 0,
    kind: 'tool_call',
    toolCall,
  });

  it('shows what the call returned', () => {
    open([call({ tool: 'predict_pka', arguments: '', result: 'pKa 15.9' })]);
    expect(screen.getByText('pKa 15.9')).toBeTruthy();
    // Exact, not a regex: the panel's own header sentence also contains the word.
    expect(screen.getByText('returned')).toBeTruthy();
  });

  it('says a call with no result yet is running', () => {
    open([call({ tool: 'submit_qm_job', arguments: '' })]);
    expect(screen.getByText(/running/)).toBeTruthy();
  });

  it('stops saying running once the call has failed', () => {
    open([call({ tool: 'predict_pka', arguments: '', failed: true })]);
    expect(screen.queryByText(/running/)).toBeNull();
  });

  it('no longer disclaims showing results, now that it shows them', () => {
    open([call({ tool: 'predict_pka', arguments: '', result: 'pKa 15.9' })]);
    expect(screen.queryByText(/invocations only/)).toBeNull();
  });
});
