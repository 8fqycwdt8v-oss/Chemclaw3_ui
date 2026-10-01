/**
 * `tool_queued`: a queued tool call says it is waiting for a compute slot, not that it is running.
 *
 * Backend `connectors/queued.py` routes a manifest's heavy tools through a queue, so on a busy
 * deployment a call can sit for seconds before a worker picks it up. Until this event the card read
 * "running…" for that whole wait — false, and the one part of the turn a chemist was watching. The
 * event annotates the open `tool_call` row (by job id, else the oldest unannotated open row for the tool),
 * the badge says "queued · N in queue" (the broker's approximate backlog, never a position), and
 * the activity line says the turn is waiting for a compute slot — as a kind of its own, because the
 * row announces to a screen reader only when the kind changes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { normalizeEvent, type ChemclawEvent } from '../shared/events.ts';
import { TracePanel } from '../src/components/TracePanel.tsx';
import { useChatStore } from '../src/state/chatStore.ts';
import { describeActivity, turnActivity } from '../src/state/turnActivity.ts';
import type { AssistantMessage } from '../src/state/types.ts';

function startTurn(): { cid: string; mid: string } {
  const store = useChatStore.getState();
  const cid = store.createConversation();
  const mid = store.startAssistantMessage(cid);
  return { cid, mid };
}

function apply(cid: string, mid: string, raw: Record<string, unknown>): void {
  const event = normalizeEvent(raw) as ChemclawEvent;
  expect(event).not.toBeNull();
  useChatStore.getState().applyEvent(cid, mid, event);
}

function message(cid: string, mid: string): AssistantMessage {
  const found = useChatStore.getState().conversations[cid]?.messages.find((m) => m.id === mid);
  if (!found || found.role !== 'assistant') throw new Error('no assistant message');
  return found;
}

/** Render the trace with its disclosure open, the way the panel's own tests read a row. */
function show(cid: string, mid: string): void {
  cleanup();
  render(<TracePanel trace={message(cid, mid).trace} />);
  fireEvent.click(screen.getByRole('button'));
}

describe('a queued tool call', () => {
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

  it('decodes, keeping "could not say" apart from zero', () => {
    const unknown = normalizeEvent({
      type: 'tool_queued',
      tool: 't',
      job_id: 'q',
      state: 'queued',
    });
    expect(unknown).toMatchObject({ type: 'tool_queued', state: 'queued', waiting: null });
    const zero = normalizeEvent({
      type: 'tool_queued',
      tool: 't',
      job_id: 'q',
      state: 'queued',
      waiting: 0,
    });
    expect(zero).toMatchObject({ waiting: 0 });
    // An unknown state is read as queued: claiming a call runs when it may not is the falsehood.
    const odd = normalizeEvent({ type: 'tool_queued', tool: 't', job_id: 'q', state: 'paused' });
    expect(odd).toMatchObject({ state: 'queued' });
  });

  it('shows "queued · N in queue" on its card, then "running…", then the result', () => {
    const { cid, mid } = startTurn();
    apply(cid, mid, { type: 'tool_call', tool: 'predict_pka', arguments: '{"smiles":"CCO"}' });
    apply(cid, mid, {
      type: 'tool_queued',
      tool: 'predict_pka',
      job_id: 'q1',
      state: 'queued',
      waiting: 4,
    });

    show(cid, mid);
    expect(screen.getByText('queued · 4 in queue')).toBeTruthy();
    expect(screen.queryByText('running…')).toBeNull();
    expect(turnActivity(message(cid, mid))).toMatchObject({
      kind: 'tool_queued',
      label: 'Waiting for a compute slot',
      tone: 'waiting',
    });
    expect(describeActivity(turnActivity(message(cid, mid)))).toBe(
      'Waiting for a compute slot for predict_pka.',
    );

    apply(cid, mid, { type: 'tool_queued', tool: 'predict_pka', job_id: 'q1', state: 'running' });
    show(cid, mid);
    expect(screen.getByText('running…')).toBeTruthy();
    expect(turnActivity(message(cid, mid))).toMatchObject({ kind: 'tool', tone: 'busy' });

    apply(cid, mid, { type: 'tool_result', tool: 'predict_pka', preview: 'pKa 15.9' });
    show(cid, mid);
    expect(screen.queryByText('running…')).toBeNull();
    expect(screen.queryByText(/queued/)).toBeNull();
    expect(message(cid, mid).trace.every((e) => !e.toolCall?.queue)).toBe(true);
  });

  it('keeps two calls to one tool apart by job id', () => {
    const { cid, mid } = startTurn();
    apply(cid, mid, { type: 'tool_call', tool: 'predict_pka', arguments: '{"smiles":"CCO"}' });
    apply(cid, mid, { type: 'tool_call', tool: 'predict_pka', arguments: '{"smiles":"CCN"}' });
    apply(cid, mid, { type: 'tool_queued', tool: 'predict_pka', job_id: 'q1', state: 'running' });
    apply(cid, mid, {
      type: 'tool_queued',
      tool: 'predict_pka',
      job_id: 'q2',
      state: 'queued',
      waiting: 2,
    });
    // A later poll of the first call must land on its own row, not on the oldest open one.
    apply(cid, mid, { type: 'tool_queued', tool: 'predict_pka', job_id: 'q1', state: 'running' });
    const states = message(cid, mid)
      .trace.filter((e) => e.kind === 'tool_call')
      .map((e) => e.toolCall?.queue?.state);
    expect(states).toEqual(['running', 'queued']);
  });

  it('reads a zero backlog as no count, since the call is itself in it', () => {
    const { cid, mid } = startTurn();
    apply(cid, mid, { type: 'tool_call', tool: 'run_python', arguments: '{}' });
    apply(cid, mid, {
      type: 'tool_queued',
      tool: 'run_python',
      job_id: 'q3',
      state: 'queued',
      waiting: 0,
    });
    show(cid, mid);
    expect(screen.getByText('queued…')).toBeTruthy();
  });

  it('says "queued…" when the broker could not say how many wait', () => {
    const { cid, mid } = startTurn();
    apply(cid, mid, { type: 'tool_call', tool: 'run_python', arguments: '{}' });
    apply(cid, mid, {
      type: 'tool_queued',
      tool: 'run_python',
      job_id: 'q2',
      state: 'queued',
      waiting: null,
    });
    show(cid, mid);
    expect(screen.getByText('queued…')).toBeTruthy();
  });

  it('adds no row of its own, and is dropped when its call has already ended', () => {
    const { cid, mid } = startTurn();
    apply(cid, mid, { type: 'tool_call', tool: 'predict_pka', arguments: '{}' });
    apply(cid, mid, { type: 'tool_result', tool: 'predict_pka', preview: 'done' });
    const before = message(cid, mid).trace.length;
    apply(cid, mid, {
      type: 'tool_queued',
      tool: 'predict_pka',
      job_id: 'q1',
      state: 'queued',
      waiting: 1,
    });
    expect(message(cid, mid).trace).toHaveLength(before);
    expect(message(cid, mid).trace.every((e) => !e.toolCall?.queue)).toBe(true);
  });
});
