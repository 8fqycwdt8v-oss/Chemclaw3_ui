/**
 * Detach recovery must bind THIS turn's answer, and never an older copy's.
 *
 * `recoverDetachedAnswer` has the server transcript and the question text, and nothing on the wire
 * joins the two to a turn — so when the same question appears twice, which copy is this turn's is
 * an inference. The inference used to be a count: how many times the question already sat in
 * `conversation.messages`, skipped over while walking the transcript. Two populations, and the
 * local one is *trimmed* by every path that shortens a conversation — `partialize` keeps the
 * newest `MAX_PERSISTED_MESSAGES`, `shedOldest` halves on a quota refusal — which is precisely the
 * reload path `resumeInterruptedTurn` exists for. An undercount stops the walk at an OLDER copy of
 * the identical question and returns *that* turn's answer, presented as this one's. On a
 * genotoxicity question a three-week-old "no alerts fired" is the worst output this app can
 * produce, and the error banner's own Retry refills the identical text, which is why repeated
 * questions are the ordinary case rather than the exotic one.
 *
 * So the population is one — the transcript — and the local list contributes one scalar that no
 * trimmer can remove: the newest answer this client already holds. Every path that shortens a
 * conversation keeps its *tail* (`slice(-n)`), so the turn's own neighbours survive whatever the
 * head loses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resumeInterruptedTurn, sendMessage } from '../src/state/sendMessage.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import type { AuthProvider } from '../src/auth/types.ts';
import type { TranscriptMessage } from '../src/api/client.ts';
import { brokenSseResponse, sseFrames, stubFetch } from './helpers.ts';

const auth: AuthProvider = {
  mode: 'dev',
  account: null,
  getAccessToken: async () => null,
  login: async () => undefined,
  logout: async () => undefined,
  handleUnauthorized: async () => false,
};

const QUESTION = 'does this compound fire any genotoxic alerts';
const STALE = 'STALE ANSWER from three weeks ago: no alerts fired.';
const FRESH = 'Two structural alerts fired: aromatic nitro, and an aryl amine.';

/** The server's whole transcript: the question twice, an unrelated turn between the two copies. */
const transcript = (over: { fresh: boolean }): TranscriptMessage[] => [
  { index: 0, role: 'user', text: QUESTION, tool_calls: [] },
  { index: 1, role: 'assistant', text: STALE, tool_calls: [] },
  { index: 2, role: 'user', text: 'what solvent did we use', tool_calls: [] },
  { index: 3, role: 'assistant', text: 'Toluene, 0.2 M.', tool_calls: [] },
  ...(over.fresh
    ? [
        { index: 4, role: 'user', text: QUESTION, tool_calls: [] },
        { index: 5, role: 'assistant', text: FRESH, tool_calls: [] },
      ]
    : []),
];

let restore: (() => void) | null = null;

/** `GET /sessions/{id}/messages` answering with `messages`; the turn stream always breaks. */
function serve(messages: TranscriptMessage[]): void {
  const stub = stubFetch((url, init) => {
    if (url.endsWith('/sessions') && init?.method === 'POST') {
      return new Response(JSON.stringify({ session_id: 's'.repeat(32) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/messages') && (init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify(messages), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return brokenSseResponse(sseFrames([{ type: 'token', text: 'thinking' }]));
  });
  restore = stub.restore;
}

/**
 * The local list a reload leaves behind for a long conversation: the newest turn, its predecessor,
 * and nothing of the older copy of the question — which `partialize` dropped off the front.
 */
function trimmedToTheTail(): { cid: string; mid: string } {
  const cid = useChatStore.getState().createConversation();
  useChatStore.getState().setSessionId(cid, 's'.repeat(32));
  useChatStore.getState().appendUserMessage(cid, 'what solvent did we use');
  const previous = useChatStore.getState().startAssistantMessage(cid);
  useChatStore.getState().applyEvent(cid, previous, {
    type: 'answer',
    text: 'Toluene, 0.2 M.',
    confidence: null,
    unsupported_claims: [],
    review_required: false,
    verified_by: null,
    challenged: false,
    review_hold_id: null,
    checks_run: [],
  });
  useChatStore.getState().finishTurn(cid, previous, 'done');
  return { cid, mid: previous };
}

/** Mark the newest assistant message the way `partialize` marks a turn a reload cut off. */
function interrupted(cid: string, mid: string): void {
  useChatStore.setState((s) => ({
    conversations: {
      ...s.conversations,
      [cid]: {
        ...s.conversations[cid]!,
        messages: s.conversations[cid]!.messages.map((m) =>
          m.id === mid
            ? { ...m, status: 'aborted' as const, interruptedByReload: true as const }
            : m,
        ),
      },
    },
  }));
}

const answerOf = (cid: string, mid: string): string | null => {
  const m = useChatStore.getState().conversations[cid]?.messages.find((x) => x.id === mid);
  return m && m.role === 'assistant' ? (m.finalText ?? null) : null;
};

beforeEach(() => {
  useChatStore.setState({
    conversations: {},
    order: [],
    activeId: null,
    drafts: {},
    composerLock: false,
    banner: null,
    jobFeed: [],
    streaming: null,
  });
});

afterEach(() => {
  restore?.();
  restore = null;
  vi.useRealTimers();
});

describe('a reload during a repeated question', () => {
  it('binds the answer the service wrote for this turn', async () => {
    vi.useFakeTimers();
    const { cid } = trimmedToTheTail();
    useChatStore.getState().appendUserMessage(cid, QUESTION);
    const mid = useChatStore.getState().startAssistantMessage(cid);
    interrupted(cid, mid);
    serve(transcript({ fresh: true }));

    resumeInterruptedTurn(cid, auth);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(answerOf(cid, mid)).toBe(FRESH);
  });

  it('binds nothing at all while only the older copy is answered', async () => {
    vi.useFakeTimers();
    const { cid } = trimmedToTheTail();
    useChatStore.getState().appendUserMessage(cid, QUESTION);
    const mid = useChatStore.getState().startAssistantMessage(cid);
    interrupted(cid, mid);
    // The turn is still running, so the service has written nothing of it: the only copy of the
    // question in the transcript is the one answered three weeks ago.
    serve(transcript({ fresh: false }));

    resumeInterruptedTurn(cid, auth);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(answerOf(cid, mid)).not.toBe(STALE);
    expect(answerOf(cid, mid)).toBeNull();
  });

  it('anchors on the newest answer, not on the first of several for the same question', async () => {
    // Asked three times. The transcript's newest pair is the *second* answer, and the second answer
    // is the one this client already holds — so the service has not written the third turn yet.
    // Anchoring on anything older than the newest answer reads that pair as new and binds it.
    vi.useFakeTimers();
    const cid = useChatStore.getState().createConversation();
    useChatStore.getState().setSessionId(cid, 's'.repeat(32));
    for (const text of ['first time round', 'second time round']) {
      useChatStore.getState().appendUserMessage(cid, QUESTION);
      const answered = useChatStore.getState().startAssistantMessage(cid);
      useChatStore.getState().applyEvent(cid, answered, {
        type: 'answer',
        text,
        confidence: null,
        unsupported_claims: [],
        review_required: false,
        verified_by: null,
        challenged: false,
        review_hold_id: null,
        checks_run: [],
      });
      useChatStore.getState().finishTurn(cid, answered, 'done');
    }
    useChatStore.getState().appendUserMessage(cid, QUESTION);
    const mid = useChatStore.getState().startAssistantMessage(cid);
    interrupted(cid, mid);
    serve([
      { index: 0, role: 'user', text: QUESTION, tool_calls: [] },
      { index: 1, role: 'assistant', text: 'first time round', tool_calls: [] },
      { index: 2, role: 'user', text: QUESTION, tool_calls: [] },
      { index: 3, role: 'assistant', text: 'second time round', tool_calls: [] },
    ]);

    resumeInterruptedTurn(cid, auth);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(answerOf(cid, mid)).toBeNull();
  });

  it('binds nothing when the newest exchange is a turn this client never saw', async () => {
    // Another window answered something else in the same session while this turn ran. The last
    // pair in the transcript is real, recent and *not this turn's* — and an answer bound to a
    // question the chemist did not ask here is the same defect with a different shape.
    vi.useFakeTimers();
    const { cid } = trimmedToTheTail();
    useChatStore.getState().appendUserMessage(cid, QUESTION);
    const mid = useChatStore.getState().startAssistantMessage(cid);
    interrupted(cid, mid);
    serve([
      { index: 0, role: 'user', text: 'what solvent did we use', tool_calls: [] },
      { index: 1, role: 'assistant', text: 'Toluene, 0.2 M.', tool_calls: [] },
      { index: 2, role: 'user', text: 'and the catalyst loading', tool_calls: [] },
      { index: 3, role: 'assistant', text: '2 mol% Pd(OAc)2.', tool_calls: [] },
    ]);

    resumeInterruptedTurn(cid, auth);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(answerOf(cid, mid)).toBeNull();
  });

  it('binds nothing when the turn before it left no answer here to anchor on', async () => {
    // The previous attempt at the same question dropped its stream and recovery gave up, so this
    // client holds no answer for it — and the service may hold one anyway. An answer already in the
    // transcript is then *possibly that one*, and there is nothing here that can tell. Waiting for
    // the transcript to move is the only honest reading; adopting what was there is how the
    // three-week-old answer gets in.
    vi.useFakeTimers();
    const cid = useChatStore.getState().createConversation();
    useChatStore.getState().setSessionId(cid, 's'.repeat(32));
    useChatStore.getState().appendUserMessage(cid, QUESTION);
    const failed = useChatStore.getState().startAssistantMessage(cid);
    useChatStore.getState().appendTokens(cid, failed, 'STALE ANSWER from');
    useChatStore.getState().failTurn(cid, failed, { kind: 'stream', message: 'Connection lost.' });
    useChatStore.getState().appendUserMessage(cid, QUESTION);
    const mid = useChatStore.getState().startAssistantMessage(cid);
    interrupted(cid, mid);
    serve([
      { index: 0, role: 'user', text: QUESTION, tool_calls: [] },
      { index: 1, role: 'assistant', text: STALE, tool_calls: [] },
    ]);

    resumeInterruptedTurn(cid, auth);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(answerOf(cid, mid)).toBeNull();
  });
});

describe('a dropped stream during a repeated question', () => {
  it('does not recover the older copy of the question as this turn"s answer', async () => {
    vi.useFakeTimers();
    const { cid } = trimmedToTheTail();
    serve(transcript({ fresh: false }));

    const turn = sendMessage({ conversationId: cid, text: QUESTION, auth });
    await vi.advanceTimersByTimeAsync(700_000);
    await turn;

    const messages = useChatStore.getState().conversations[cid]!.messages;
    const last = messages[messages.length - 1]!;
    expect(last.role === 'assistant' && last.finalText).not.toBe(STALE);
  }, 30_000);
});
