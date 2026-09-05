import { beforeEach, describe, expect, it } from 'vitest';
import { newConversation, useChatStore } from '../src/state/chatStore.ts';
import type { AssistantMessage } from '../src/state/types.ts';
import { answerEvent } from './helpers.ts';

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
    useChatStore
      .getState()
      .applyEvent(cid, mid, answerEvent({ text: 'Acetic acid.', confidence: 0.9 }));

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

    useChatStore.getState().applyEvent(cid, mid, { type: 'plan', todos: ['a'], plan_hash: 'h' });
    useChatStore
      .getState()
      .applyEvent(cid, mid, { type: 'tool_call', tool: 'gather_evidence', arguments: '{}' });
    useChatStore
      .getState()
      .applyEvent(cid, mid, { type: 'plan', todos: ['a', 'b'], plan_hash: 'h' });

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
    useChatStore.getState().applyEvent(cid, mid, answerEvent({ text: 'x' }));
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
    useChatStore.getState().pushJobFinished(
      {
        type: 'job_completed',
        job_id: 'qm-1',
        summary: { molecule_smiles: 'CCO', total_energy_hartree: -154.09, converged: true },
      },
      'a'.repeat(32),
    );
    const item = useChatStore.getState().jobFeed[0]?.event;
    expect(item?.type).toBe('job_completed');
    expect(item?.type === 'job_completed' && item.summary.molecule_smiles).toBe('CCO');
  });

  it('keeps a job failure in the same feed, as a failure', () => {
    // The case the feed used to drop entirely: `job_failed` was not in `EVENT_TYPES`, so
    // `normalizeEvent` returned null and the launch row went on saying "runs asynchronously".
    useChatStore
      .getState()
      .pushJobFinished(
        { type: 'job_failed', job_id: 'qm-2', reason: 'the solver did not converge' },
        'a'.repeat(32),
      );
    const item = useChatStore.getState().jobFeed[0]?.event;
    expect(item?.type).toBe('job_failed');
    expect(item?.type === 'job_failed' && item.reason).toBe('the solver did not converge');
  });
});

describe('removing conversations does not strand live state', () => {
  // deleteConversation existed from the beginning with no caller. Giving it one (the row menu)
  // exposed that it tore down the conversation but not the turn attached to it.
  const seed = (over: Partial<ReturnType<typeof useChatStore.getState>> = {}) => {
    useChatStore.setState({
      conversations: {
        a: { ...newConversation(), id: 'a', title: 'a' },
        b: { ...newConversation(), id: 'b', title: 'b' },
      },
      order: ['a', 'b'],
      activeId: 'a',
      drafts: { a: 'half-written question', b: 'other draft' },
      composerLock: false,
      banner: null,
      streaming: null,
      ...over,
    });
  };

  /**
   * A `streaming` slot whose two ways of ending a turn are distinguishable.
   *
   * `stop()` is the real one — it posts `/sessions/{id}/turn/stop` and *then* aborts — and the
   * abort alone only detaches. A fixture that defines `stop` as the abort cannot tell the store
   * calling the wrong one, which is how the store came to.
   */
  const turnSlot = (conversationId: string) => {
    const abort = new AbortController();
    let asked = false;
    let abandoned = false;
    return {
      abort,
      stopped: () => asked,
      abandoned: () => abandoned,
      slot: {
        conversationId,
        messageId: 'm1',
        abort,
        stop: () => {
          asked = true;
          abort.abort();
        },
        // Distinct from `stop`, and tracked separately for the same reason `stopped` exists: a
        // detach and a stop are different requests since
        // `D-2026-08-27-a-disconnect-is-a-detach-not-a-stop`, and a fixture that collapsed them
        // would pass whichever the store called.
        abandon: () => {
          abandoned = true;
        },
      },
    };
  };

  it('drops the deleted conversation’s draft', () => {
    seed();
    useChatStore.getState().deleteConversation('a');

    expect(useChatStore.getState().drafts.a).toBeUndefined();
    expect(useChatStore.getState().drafts.b).toBe('other draft');
  });

  it('stops the turn on the server, not only the local stream', () => {
    // **`stop()`, not `abort()`.** The two stopped being equivalent at
    // `D-2026-08-27-a-disconnect-is-a-detach-not-a-stop`: a dropped connection detaches now, so
    // aborting alone leaves the turn generating for up to its 600 s deadline, spending the budget
    // and holding the admission permit a queued turn waits on. `stop()` posts
    // `/sessions/{id}/turn/stop` first.
    //
    // The fixture has to tell them apart, and it did not: every one of these tests seeded
    // `stop: () => abort.abort()`, so `expect(abort.signal.aborted).toBe(true)` passed identically
    // whichever the store called, and the store called the wrong one.
    const { slot, stopped, abort } = turnSlot('a');
    seed({ composerLock: 'turn_in_flight', streaming: slot });

    useChatStore.getState().deleteConversation('a');

    expect(stopped()).toBe(true);
    // Without this the composer stays locked forever: the turn it waits on can no longer report.
    expect(abort.signal.aborted).toBe(true);
    expect(useChatStore.getState().streaming).toBeNull();
    expect(useChatStore.getState().composerLock).toBe(false);
    expect(useChatStore.getState().activeId).toBe('b');
  });

  it('leaves a turn belonging to another conversation alone', () => {
    const { slot, stopped, abort } = turnSlot('a');
    seed({ composerLock: 'turn_in_flight', streaming: slot });

    useChatStore.getState().deleteConversation('b');

    expect(stopped()).toBe(false);
    expect(abort.signal.aborted).toBe(false);
    expect(useChatStore.getState().streaming).not.toBeNull();
    expect(useChatStore.getState().composerLock).toBe('turn_in_flight');
  });

  it('clearAll leaves nothing behind — the server-side turn included', () => {
    // Same argument as the delete above, with more force: "Reset app" is what a chemist reaches
    // for when a turn is wedged, which is exactly when leaving it running is worst.
    const { slot, stopped, abort } = turnSlot('a');
    seed({ composerLock: 'turn_in_flight', streaming: slot });

    useChatStore.getState().clearAll();

    expect(stopped()).toBe(true);
    expect(abort.signal.aborted).toBe(true);
    expect(useChatStore.getState().drafts).toEqual({});
    expect(useChatStore.getState().composerLock).toBe(false);
    expect(Object.keys(useChatStore.getState().conversations)).toHaveLength(1);
  });
});

describe('plan approval reaching the message', () => {
  it('records an approval_request with an empty id as a plan approval', () => {
    // The service marks a plan approval by an *empty* approval_id (a durable hold always carries
    // one), and the assistant bubble mounts its plan card on exactly that shape. The id must
    // survive the store as the empty string, not be dropped or defaulted.
    const store = useChatStore.getState();
    const cid = store.createConversation();
    const mid = useChatStore.getState().startAssistantMessage(cid);
    useChatStore
      .getState()
      .applyEvent(cid, mid, { type: 'plan', todos: ['[ ] compute the pKa'], plan_hash: 'h' });
    useChatStore.getState().applyEvent(cid, mid, {
      type: 'approval_request',
      prompt: 'This plan is waiting for your decision.',
      approval_id: '',
    });
    const message = assistantOf(cid, mid);
    const approval = message.trace.findLast((e) => e.kind === 'approval_request')?.approval;
    expect(approval?.prompt).toBe('This plan is waiting for your decision.');
    expect(message.latestPlan).toEqual(['[ ] compute the pKa']);
    expect(message.latestPlanHash).toBe('h');
  });

  it('attaches a rehydrated plan to the newest assistant message only', () => {
    const store = useChatStore.getState();
    const cid = store.createConversation();
    const first = useChatStore.getState().startAssistantMessage(cid);
    useChatStore.getState().finishTurn(cid, first, 'done');
    const second = useChatStore.getState().startAssistantMessage(cid);
    useChatStore.getState().finishTurn(cid, second, 'done');

    useChatStore.getState().attachPlan(cid, ['compute the pKa'], 'h-2');

    expect(assistantOf(cid, first).latestPlan).toBeNull();
    expect(assistantOf(cid, second).latestPlan).toEqual(['compute the pKa']);
    expect(assistantOf(cid, second).latestPlanHash).toBe('h-2');
  });

  it('attaches no empty plan', () => {
    const store = useChatStore.getState();
    const cid = store.createConversation();
    const mid = useChatStore.getState().startAssistantMessage(cid);
    useChatStore.getState().finishTurn(cid, mid, 'done');
    useChatStore.getState().attachPlan(cid, [], 'h');
    expect(assistantOf(cid, mid).latestPlan).toBeNull();
  });
});

describe('one evidence sweep is one trace entry', () => {
  const sweep = (
    cid: string,
    mid: string,
    reports: { source: string; chunks: number; failed?: boolean }[],
  ): void => {
    for (const r of reports) {
      useChatStore.getState().applyEvent(cid, mid, {
        type: 'evidence_source',
        source: r.source,
        chunks: r.chunks,
        ...(r.failed === undefined ? {} : { failed: r.failed }),
      });
    }
  };

  it('folds consecutive sources into one entry carrying every report', () => {
    // `gather_evidence` asks every source at once and the service reports each separately, so a
    // five-source sweep arrives as five events. Folding at the store rather than at the rail is
    // what keeps a retrieval-heavy turn from spending its bounded `MAX_TRACE_ENTRIES` on
    // retrieval and evicting its own early tool calls — and the result blocks hanging off them.
    const store = useChatStore.getState();
    const cid = store.createConversation();
    const mid = useChatStore.getState().startAssistantMessage(cid);

    sweep(cid, mid, [
      { source: 'graph', chunks: 6 },
      { source: 'lexical', chunks: 0, failed: true },
      { source: 'eln', chunks: 2 },
    ]);

    const trace = assistantOf(cid, mid).trace;
    expect(trace).toHaveLength(1);
    expect(trace[0]?.evidenceSweep).toEqual([
      { source: 'graph', chunks: 6, failed: false },
      { source: 'lexical', chunks: 0, failed: true },
      { source: 'eln', chunks: 2, failed: false },
    ]);
    // "failed" and "0" are different answers, and the fold must not flatten one into the other: a
    // dark source is a question about the corpus, a broken one is a page for whoever owns it.
    expect(trace[0]?.evidenceSweep?.filter((s) => s.failed)).toHaveLength(1);
  });

  it('starts a new entry when anything happened in between', () => {
    // Consecutive is the whole test, and it is the right one: the events of one `gather_evidence`
    // call arrive together. A second call after a tool call is a second sweep, and merging the two
    // would report one retrieval where there were two.
    const store = useChatStore.getState();
    const cid = store.createConversation();
    const mid = useChatStore.getState().startAssistantMessage(cid);

    sweep(cid, mid, [{ source: 'graph', chunks: 6 }]);
    useChatStore
      .getState()
      .applyEvent(cid, mid, { type: 'tool_call', tool: 'screen_hazards', arguments: '{}' });
    sweep(cid, mid, [{ source: 'graph', chunks: 1 }]);

    const kinds = assistantOf(cid, mid).trace.map((e) => e.kind);
    expect(kinds).toEqual(['evidence_source', 'tool_call', 'evidence_source']);
  });

  it('keeps the first source under the field a rehydrated transcript reads', () => {
    // A trace persisted before `evidenceSweep` existed carries only `evidenceSource`, and the rail
    // falls back to it. Writing both keeps that fallback exercised rather than theoretical.
    const store = useChatStore.getState();
    const cid = store.createConversation();
    const mid = useChatStore.getState().startAssistantMessage(cid);
    sweep(cid, mid, [
      { source: 'graph', chunks: 6 },
      { source: 'eln', chunks: 2 },
    ]);

    expect(assistantOf(cid, mid).trace[0]?.evidenceSource).toEqual({
      source: 'graph',
      chunks: 6,
      failed: false,
    });
  });
});
