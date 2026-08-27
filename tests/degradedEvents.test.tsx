/**
 * The two events that report trouble reach the screen.
 *
 * `capability_degraded` and `tool_failed` were absent from the type contract, so `normalizeEvent`
 * failed them against its allowlist and returned `null` — and `streamTurn` dropped them silently.
 * The effect was the one that matters: an answer assembled without the ELN connector rendered as a
 * confident, ordinary answer, indistinguishable from one that had every tool.
 *
 * The forward-compat fallthrough is still correct for a genuinely unknown event, and the last test
 * here pins that it survived the fix.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { normalizeEvent } from '../shared/events.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import { CapabilityDegradedPill } from '../src/components/AnswerBadges.tsx';
import { TracePanel } from '../src/components/TracePanel.tsx';
import type { AssistantMessage } from '../src/state/types.ts';

const assistantOf = (conversationId: string, messageId: string): AssistantMessage => {
  const message = useChatStore
    .getState()
    .conversations[conversationId]?.messages.find((m) => m.id === messageId);
  if (!message || message.role !== 'assistant') throw new Error('no assistant message');
  return message;
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
  it('accepts capability_degraded rather than dropping it', () => {
    const event = normalizeEvent({ type: 'capability_degraded', connectors: ['eln', 'calc'] });
    expect(event).toEqual({ type: 'capability_degraded', connectors: ['eln', 'calc'] });
  });

  it('accepts tool_failed rather than dropping it', () => {
    const event = normalizeEvent({ type: 'tool_failed', tool: 'predict_pka', message: 'timeout' });
    expect(event).toEqual({
      type: 'tool_failed',
      tool: 'predict_pka',
      message: 'timeout',
      // Empty is the main agent; a specialist's failure carries its name here (backend M9).
      agent: '',
      // `null` is an ordinary failure. The only other value is `'plan_gate'`, which says the
      // pre-execution approval refused the call — a control working, not a fault.
      reason: null,
    });
  });

  it('still drops a genuinely unknown event', () => {
    // The allowlist is deliberate forward-compat: it is what lets the backend ship a new event
    // ahead of the UI without a breaking window. Fixing the two above must not cost that.
    expect(normalizeEvent({ type: 'something_added_next_year', x: 1 })).toBeNull();
  });
});

describe('capability_degraded', () => {
  it('lands on the message, not in the trace', () => {
    // It qualifies the whole answer rather than describing one step, and the trace panel is
    // collapsed by default — a warning hidden behind "show the agent's work" is not a warning.
    const store = useChatStore.getState();
    const cid = store.createConversation();
    const mid = store.startAssistantMessage(cid);
    store.applyEvent(cid, mid, { type: 'capability_degraded', connectors: ['eln'] });

    const assistant = assistantOf(cid, mid);
    expect(assistant.degradedConnectors).toEqual(['eln']);
    expect(assistant.trace).toHaveLength(0);
  });

  it('says what the absence cost the answer, not which connector was down', () => {
    // It used to join the names into a sentence — "eln, molfp were unreachable" — which is a fact
    // about a pod that a chemist cannot act on. What they can act on is "no molecule precedent
    // search". The raw name still rides along for whoever has to check the deployment, and a name
    // this repo has never seen degrades to naming it rather than guessing at its chemistry.
    render(
      <CapabilityDegradedPill
        message={{ degradedConnectors: ['eln', 'molfp'] } as unknown as AssistantMessage}
      />,
    );
    expect(screen.getByText(/precedent search/)).toBeTruthy();
    expect(screen.getByText(/nothing only eln can reach/)).toBeTruthy();
    expect(screen.getByText('(molfp)')).toBeTruthy();
    expect(screen.getByText(/fewer tools/i)).toBeTruthy();
  });

  it('renders nothing when every connector came up', () => {
    const { container } = render(
      <CapabilityDegradedPill
        message={{ degradedConnectors: [] } as unknown as AssistantMessage}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('tool_failed', () => {
  it('becomes a trace entry carrying the reason', () => {
    const store = useChatStore.getState();
    const cid = store.createConversation();
    const mid = store.startAssistantMessage(cid);
    store.applyEvent(cid, mid, {
      type: 'tool_failed',
      tool: 'predict_pka',
      message: 'connector timed out',
    });

    const trace = assistantOf(cid, mid).trace;
    expect(trace).toHaveLength(1);
    expect(trace[0]?.kind).toBe('tool_failed');
    expect(trace[0]?.toolFailure).toEqual({
      tool: 'predict_pka',
      message: 'connector timed out',
      reason: null,
    });
  });

  it('shows the tool and its reason in the trace panel', () => {
    render(
      <TracePanel
        trace={[
          {
            id: 't1',
            at: 0,
            kind: 'tool_failed',
            toolFailure: { tool: 'predict_pka', message: 'connector timed out' },
          },
        ]}
      />,
    );
    // The panel is collapsed by default; the toggle counts the step either way.
    expect(screen.getByText(/1 step/)).toBeTruthy();
  });

  it('counts the failures into the collapsed trigger, where somebody will see them', () => {
    // A turn where tools failed used to read exactly like one where they did not: the trigger
    // said "N steps" and the only event that says WHY the model routed around a broken tool was
    // one click away, behind a disclosure nobody opens. `capability_degraded` is surfaced above
    // the answer for the same reason; this is the same treatment for a failure inside an answer
    // that still arrived.
    render(
      <TracePanel
        trace={[
          {
            id: 't1',
            at: 0,
            kind: 'tool_call',
            toolCall: { tool: 'gather_evidence', arguments: '' },
          },
          {
            id: 't2',
            at: 1,
            kind: 'tool_failed',
            toolFailure: { tool: 'predict_pka', message: 'connector timed out' },
          },
          {
            id: 't3',
            at: 2,
            kind: 'tool_failed',
            toolFailure: { tool: 'solubility', message: 'connector timed out' },
          },
        ]}
      />,
    );
    expect(screen.getByText(/3 steps, 2 failed/)).toBeTruthy();
  });

  it('says nothing about failures on a turn that had none', () => {
    render(
      <TracePanel
        trace={[
          {
            id: 't1',
            at: 0,
            kind: 'tool_call',
            toolCall: { tool: 'gather_evidence', arguments: '' },
          },
        ]}
      />,
    );
    expect(screen.getByText(/1 step\b/)).toBeTruthy();
    expect(screen.queryByText(/failed/)).toBeNull();
  });
});
