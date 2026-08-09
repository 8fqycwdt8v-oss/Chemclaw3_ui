import { answerEvent } from './helpers.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '../src/state/chatStore.ts';
import type { AssistantMessage } from '../src/state/types.ts';

const reset = (): void => {
  useChatStore.setState({
    conversations: {},
    order: [],
    activeId: null,
    composerLock: false,
    banner: null,
    jobFeed: [],
    streaming: null,
  });
};

const assistantOf = (conversationId: string, messageId: string): AssistantMessage => {
  const message = useChatStore
    .getState()
    .conversations[conversationId]?.messages.find((m) => m.id === messageId);
  if (!message || message.role !== 'assistant') throw new Error('no assistant message');
  return message;
};

beforeEach(reset);

describe('chatStore', () => {
  it('accumulates streamed tokens', () => {
    const store = useChatStore.getState();
    const cid = store.createConversation();
    const mid = useChatStore.getState().startAssistantMessage(cid);

    useChatStore.getState().applyEvent(cid, mid, { type: 'token', text: 'Acetic ' });
    useChatStore.getState().applyEvent(cid, mid, { type: 'token', text: 'acid.' });

    expect(assistantOf(cid, mid).streamedText).toBe('Acetic acid.');
  });

  it('sets finalText from the answer and never appends it to streamedText', () => {
    // The double-render trap: answer.text is the FULL concatenation of every token, so any code
    // path that combined the two fields would render the whole answer twice.
    const cid = useChatStore.getState().createConversation();
    const mid = useChatStore.getState().startAssistantMessage(cid);

    useChatStore.getState().applyEvent(cid, mid, { type: 'token', text: 'Acetic ' });
    useChatStore.getState().applyEvent(cid, mid, { type: 'token', text: 'acid.' });
    useChatStore.getState().applyEvent(
      cid,
      mid,
      answerEvent({
        text: 'Acetic acid.',
        confidence: 0.9,
        unsupported_claims: [],
        review_required: false,
      }),
    );

    const message = assistantOf(cid, mid);
    expect(message.streamedText).toBe('Acetic acid.');
    expect(message.finalText).toBe('Acetic acid.');
    // What the renderer shows — exactly one copy.
    expect(message.finalText ?? message.streamedText).toBe('Acetic acid.');
    expect(message.confidence).toBe(0.9);
  });

  it('records verifier signals from the answer', () => {
    const cid = useChatStore.getState().createConversation();
    const mid = useChatStore.getState().startAssistantMessage(cid);
    useChatStore.getState().applyEvent(
      cid,
      mid,
      answerEvent({
        text: 'maybe',
        confidence: 0.31,
        unsupported_claims: ['yield was 92%'],
        review_required: true,
      }),
    );

    const message = assistantOf(cid, mid);
    expect(message.reviewRequired).toBe(true);
    expect(message.unsupportedClaims).toEqual(['yield was 92%']);
  });

  it('keeps trace entries in arrival order and tracks the newest plan', () => {
    const cid = useChatStore.getState().createConversation();
    const mid = useChatStore.getState().startAssistantMessage(cid);

    useChatStore.getState().applyEvent(cid, mid, { type: 'plan', todos: ['a'] });
    useChatStore
      .getState()
      .applyEvent(cid, mid, { type: 'tool_call', tool: 'gather_evidence', arguments: '{}' });
    useChatStore.getState().applyEvent(cid, mid, { type: 'plan', todos: ['a', 'b'] });

    const message = assistantOf(cid, mid);
    expect(message.trace.map((e) => e.kind)).toEqual(['plan', 'tool_call', 'plan']);
    // Plan snapshots accumulate in the trace so the panel shows the plan evolving, while the
    // header shows only the current one.
    expect(message.latestPlan).toEqual(['a', 'b']);
  });

  it('does not create a trace entry for tokens or answers', () => {
    const cid = useChatStore.getState().createConversation();
    const mid = useChatStore.getState().startAssistantMessage(cid);
    useChatStore.getState().applyEvent(cid, mid, { type: 'token', text: 'x' });
    useChatStore.getState().applyEvent(
      cid,
      mid,
      answerEvent({
        text: 'x',
        confidence: null,
        unsupported_claims: [],
        review_required: false,
      }),
    );
    expect(assistantOf(cid, mid).trace).toHaveLength(0);
  });

  it('titles a conversation from its first user message only', () => {
    const cid = useChatStore.getState().createConversation();
    useChatStore.getState().appendUserMessage(cid, 'What is the pKa of acetic acid?');
    useChatStore.getState().appendUserMessage(cid, 'And in DMSO?');
    expect(useChatStore.getState().conversations[cid]?.title).toBe(
      'What is the pKa of acetic acid?',
    );
  });

  it('marks the conversation context-lost when the session is replaced', () => {
    // Swapping the server handle keeps the visible transcript, but the AGENT has forgotten it —
    // so this must be surfaced rather than silently papered over.
    const cid = useChatStore.getState().createConversation();
    useChatStore.getState().setSessionId(cid, 'a'.repeat(32));
    expect(useChatStore.getState().conversations[cid]?.contextLost).toBe(false);

    useChatStore.getState().setSessionId(cid, 'b'.repeat(32), true);
    const conversation = useChatStore.getState().conversations[cid];
    expect(conversation?.sessionId).toBe('b'.repeat(32));
    expect(conversation?.contextLost).toBe(true);
  });

  it('keeps a job completion in the cross-turn feed', () => {
    useChatStore.getState().pushJobEvent({
      type: 'job_completed',
      job_id: 'qm-1',
      summary: { molecule_smiles: 'CCO', total_energy_hartree: -154.09, converged: true },
    });
    const entry = useChatStore.getState().jobFeed[0];
    expect(entry?.type).toBe('job_completed');
    expect(entry?.type === 'job_completed' && entry.summary.molecule_smiles).toBe('CCO');
  });

  it('keeps a job FAILURE in the same feed', () => {
    // The case that produced nothing at all before: the turn stream promised a running job and
    // there was no channel that could ever retract it.
    useChatStore.getState().pushJobEvent({
      type: 'job_failed',
      job_id: 'qm-2',
      reason: 'xtb exited with status 1',
    });
    const entry = useChatStore.getState().jobFeed[0];
    expect(entry?.type).toBe('job_failed');
    expect(entry?.type === 'job_failed' && entry.reason).toBe('xtb exited with status 1');
  });

  it('lets a failure replace the completion card for the same job id', () => {
    useChatStore.getState().pushJobEvent({ type: 'job_completed', job_id: 'qm-3', summary: {} });
    useChatStore.getState().pushJobEvent({ type: 'job_failed', job_id: 'qm-3', reason: 'timeout' });
    expect(useChatStore.getState().jobFeed).toHaveLength(1);
    expect(useChatStore.getState().jobFeed[0]?.type).toBe('job_failed');
  });
});
