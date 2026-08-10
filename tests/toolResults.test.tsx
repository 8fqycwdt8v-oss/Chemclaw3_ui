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
import { toolResultEvent } from './helpers.ts';

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
    expect(normalizeEvent(toolResultEvent({ tool: 'predict_pka', preview: 'pKa 9.2' }))).toEqual(
      toolResultEvent({ tool: 'predict_pka', preview: 'pKa 9.2' }),
    );
  });

  it('coerces a malformed frame rather than dropping the event', () => {
    // The preview crosses a process boundary; a bad field should cost the value, not the event.
    // A raw literal on purpose — the builder is typed, and these values are exactly the ones
    // the type system says cannot happen and the wire produces anyway.
    expect(
      normalizeEvent({ type: 'tool_result', tool: 7, preview: null, numbers: [1, 'x', NaN] }),
    ).toEqual(toolResultEvent({ tool: 'unknown', numbers: [1] }));
  });

  it('carries the result ref, the cited notes and the numbers', () => {
    // These three are untruncated even when `preview` is not, which is the whole reason they are
    // separate fields: a citation must survive the cut that loses the sentence around it.
    expect(
      normalizeEvent({
        type: 'tool_result',
        tool: 'gather_evidence',
        preview: 'Suzuki coupling in 2-MeTHF, 92% …',
        result_ref: 'a'.repeat(64),
        note_ids: ['note-1', 'note-2'],
        numbers: [92.0, 4.76],
      }),
    ).toEqual(
      toolResultEvent({
        tool: 'gather_evidence',
        preview: 'Suzuki coupling in 2-MeTHF, 92% …',
        result_ref: 'a'.repeat(64),
        note_ids: ['note-1', 'note-2'],
        numbers: [92.0, 4.76],
      }),
    );
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
    store.applyEvent(cid, mid, toolResultEvent({ tool: 'predict_pka', preview: 'pKa 15.9' }));

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
    store.applyEvent(cid, mid, toolResultEvent({ tool: 'predict_pka', preview: 'A' }));
    store.applyEvent(cid, mid, toolResultEvent({ tool: 'predict_pka', preview: 'B' }));

    const trace = assistantOf(cid, mid).trace;
    expect(trace.map((e) => e.toolCall?.result)).toEqual(['A', 'B']);
  });

  it('discards a result whose call is not in the trace', () => {
    const { cid, mid } = startTurn();
    useChatStore
      .getState()
      .applyEvent(cid, mid, toolResultEvent({ tool: 'predict_pka', preview: 'orphan' }));

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

describe('a durable job’s ending reaches the trace', () => {
  // Its own opener rather than the one in the block above: `open` there is block-scoped, and the
  // name resolves to `window.open` from here, which fails somewhere much less obvious.
  const openTrace = (trace: TraceEntry[]): void => {
    render(<TracePanel trace={trace} />);
    fireEvent.click(screen.getByRole('button'));
  };

  const launch = (jobId: string, settled?: boolean): TraceEntry => ({
    id: `s-${jobId}`,
    at: 0,
    kind: 'job_started',
    job: { jobId, kind: 'qm', ...(settled ? { settled: true } : {}) },
  });

  it('takes the "runs asynchronously" badge off a job that has ended', () => {
    const { cid, mid } = startTurn();
    const store = useChatStore.getState();
    store.applyEvent(cid, mid, { type: 'job_started', job_id: 'qm-1', kind: 'qm' });
    store.applyEvent(cid, mid, { type: 'job_failed', job_id: 'qm-1', reason: 'cluster evicted' });

    const trace = assistantOf(cid, mid).trace;
    expect(trace[0]?.job?.settled).toBe(true);
    expect(trace[1]?.jobFailure?.reason).toBe('cluster evicted');
  });

  it('leaves a different job’s launch row alone', () => {
    const { cid, mid } = startTurn();
    const store = useChatStore.getState();
    store.applyEvent(cid, mid, { type: 'job_started', job_id: 'qm-1', kind: 'qm' });
    store.applyEvent(cid, mid, { type: 'job_failed', job_id: 'qm-2', reason: 'other' });

    expect(assistantOf(cid, mid).trace[0]?.job?.settled).toBeUndefined();
  });

  it('a completion settles the launch row too', () => {
    // Both endings, not just the bad one: the badge is a claim in the present tense either way.
    const { cid, mid } = startTurn();
    const store = useChatStore.getState();
    store.applyEvent(cid, mid, { type: 'job_started', job_id: 'qm-1', kind: 'qm' });
    store.applyEvent(cid, mid, { type: 'job_completed', job_id: 'qm-1', summary: {} });

    expect(assistantOf(cid, mid).trace[0]?.job?.settled).toBe(true);
  });

  it('renders the badge while a job is running and drops it once it is not', () => {
    openTrace([launch('qm-1')]);
    expect(screen.getByText('runs asynchronously')).toBeTruthy();
    cleanup();
    openTrace([launch('qm-1', true)]);
    expect(screen.queryByText('runs asynchronously')).toBeNull();
  });
});
