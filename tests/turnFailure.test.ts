/**
 * What a failed turn leaves behind.
 *
 * Four defects, all of them in the space between "the turn did not work" and "the chemist can try
 * again", and all of them proven against this code:
 *
 *  - A shed turn reaching the chemist as something final. The service sheds when admission
 *    control has no permit free within its timeout, and says so with `code="at_capacity"`,
 *    `retryable=true` and the message "server at capacity; retry shortly" — its own ADR calls this
 *    "'not now', not 'not ever'". Two versions of this client got it wrong in turn, and the second
 *    is why this file names the code it asserts against: while the service sent a shed as a
 *    retryable `budget_exhausted`, the UI hardcoded `retryable: false`, locked the composer and
 *    told the chemist the budget was gone until it resets; after the service split the two codes,
 *    the UI knew only the old one, so a shed normalised to `internal` and became a generic agent
 *    error with no Retry offered. The service was fine a second later, both times.
 *  - The message they typed was cleared at submit and never restored, so a failure lost it.
 *  - Switching conversation mid-turn cleared the *global* composer lock, which let a second turn
 *    start and overwrite the single `streaming` slot — the first turn's `AbortController` became
 *    unreachable, so Stop could no longer release the backend's turn lease.
 *  - `hydrateTranscript` replaced the message array unconditionally, so a transcript that arrived
 *    just after Send discarded the turn that had already started.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '../src/state/chatStore.ts';
import { sendMessage, stopStreaming } from '../src/state/sendMessage.ts';
import type { AuthProvider } from '../src/auth/types.ts';
import { errorEvent, sseFrames, sseResponse, stubFetch } from './helpers.ts';

const devAuth: AuthProvider = {
  mode: 'dev',
  account: null,
  getAccessToken: async () => null,
  login: async () => undefined,
  logout: async () => undefined,
  handleUnauthorized: async () => false,
};

const SESSION = 'a'.repeat(32);

let restore: (() => void) | null = null;

beforeEach(() => {
  useChatStore.setState({
    conversations: {},
    order: [],
    activeId: null,
    composerLock: false,
    banner: null,
    drafts: {},
    jobFeed: [],
    streaming: null,
  });
});

afterEach(() => {
  restore?.();
  restore = null;
});

/** A session mint, then whatever `frames` says the turn does. */
function stubTurn(frames: string): void {
  const stub = stubFetch((url, init) => {
    if (url.endsWith('/sessions') && init?.method === 'POST') {
      return new Response(JSON.stringify({ session_id: SESSION }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return sseResponse(frames);
  });
  restore = stub.restore;
}

describe('the service shedding a turn', () => {
  it('is offered as a retry rather than as a budget that will not come back', async () => {
    // Exactly the frames `routes/turns.py` yields when the admission semaphore sheds: the code
    // is `at_capacity`, not `budget_exhausted`, and the two mean opposite things.
    stubTurn(
      sseFrames([
        errorEvent({
          message: 'server at capacity; retry shortly',
          code: 'at_capacity',
          retryable: true,
          correlation_id: 'abc123',
        }),
      ]),
    );

    const cid = useChatStore.getState().createConversation();
    await sendMessage({ conversationId: cid, text: 'hello', auth: devAuth });

    // Before: 'budget_exhausted' — Send disabled, "New turns are refused until it resets", and
    // no Retry anywhere. The only escape was clicking another conversation, or reloading. Then,
    // once the service gave shedding its own code: `internal`, a generic agent error, and still
    // no Retry — the same dead end reached by not knowing the code rather than by mis-reading it.
    expect(useChatStore.getState().composerLock).toBe(false);
    expect(useChatStore.getState().banner?.action).toBe('retry');
    // The kind is asserted as well as the affordance, because "the banner happens to offer Retry"
    // is also true of every unclassified failure the service marks retryable. This one is
    // classified: the same kind a 503 from the front door produces, which is the one condition
    // reaching this client on two paths.
    const message = useChatStore.getState().conversations[cid]?.messages.at(-1);
    expect(message?.role === 'assistant' && message.error?.kind).toBe('capacity');
    expect(useChatStore.getState().banner?.text).toContain('server at capacity');
  });

  it('still locks the composer when the budget really is exhausted', async () => {
    stubTurn(
      sseFrames([
        errorEvent({
          message: 'The usage budget for this service is exhausted.',
          code: 'budget_exhausted',
          retryable: false,
        }),
      ]),
    );

    const cid = useChatStore.getState().createConversation();
    await sendMessage({ conversationId: cid, text: 'hello', auth: devAuth });

    expect(useChatStore.getState().composerLock).toBe('budget_exhausted');
    expect(useChatStore.getState().banner?.action).toBeUndefined();
  });
});

describe('a turn that failed', () => {
  it('gives the chemist their question back', async () => {
    stubTurn(
      sseFrames([errorEvent({ message: 'the tool host is unreachable', code: 'internal' })]),
    );

    const cid = useChatStore.getState().createConversation();
    // The composer clears the draft at submit, which is why the failure has to put it back.
    useChatStore.getState().setDraft(cid, '');
    await sendMessage({ conversationId: cid, text: 'what is the pKa of aspirin?', auth: devAuth });

    expect(useChatStore.getState().drafts[cid]).toBe('what is the pKa of aspirin?');
  });
});

describe('switching conversation while a turn runs', () => {
  it('does not unlock the composer, start a second turn, or orphan the first', async () => {
    let turnRequests = 0;
    // A holder rather than a bare `let`: TypeScript narrows a variable assigned only inside a
    // callback to `null` and then refuses the `.close()` below.
    const stream: { controller: ReadableStreamDefaultController<Uint8Array> | null } = {
      controller: null,
    };
    // A turn that never finishes on its own, so the switch happens mid-stream.
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ session_id: SESSION }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      turnRequests += 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream.controller = controller;
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    });
    restore = stub.restore;

    const a = useChatStore.getState().createConversation();
    const b = useChatStore.getState().createConversation();
    useChatStore.getState().selectConversation(a);

    const first = sendMessage({ conversationId: a, text: 'a long question', auth: devAuth });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const runningTurn = useChatStore.getState().streaming;
    expect(runningTurn?.conversationId).toBe(a);

    useChatStore.getState().selectConversation(b);
    // Before: `selectConversation` cleared this, and `Composer` derives its own blocking per
    // conversation — so nothing in B was blocked and a second turn could start.
    expect(useChatStore.getState().composerLock).toBe('turn_in_flight');

    await sendMessage({ conversationId: b, text: 'another question', auth: devAuth });
    expect(turnRequests).toBe(1);
    // The `streaming` slot is a single one, so a second turn would have overwritten it and left
    // this controller unreachable. Stop must still reach the turn that is actually running.
    stopStreaming();
    expect(runningTurn?.abort.signal.aborted).toBe(true);

    // The stub's stream does not itself observe the abort signal, so end it by hand and let the
    // turn settle rather than leaving a promise hanging over the rest of the suite.
    stream.controller?.close();
    await first;
  });
});

describe('a transcript that arrives after the chemist has already typed', () => {
  it('does not replace the turn that is streaming into the conversation', () => {
    const cid = useChatStore.getState().createConversation();
    useChatStore.getState().appendUserMessage(cid, 'my new question');
    const messageId = useChatStore.getState().startAssistantMessage(cid);

    // The rehydrate effect started while the conversation was empty and resolves now.
    useChatStore
      .getState()
      .hydrateTranscript(cid, [{ id: 'h0', role: 'user', text: 'older question', at: 1 }]);

    const messages = useChatStore.getState().conversations[cid]?.messages ?? [];
    // Before: `['h0']` — and every later token was dropped in silence, because
    // `updateAssistant` matches on a message id that is no longer in the array.
    expect(messages.map((m) => m.id)).toContain(messageId);

    useChatStore.getState().appendTokens(cid, messageId, 'the answer');
    const assistant = useChatStore
      .getState()
      .conversations[cid]?.messages.find((m) => m.id === messageId);
    expect(assistant?.role === 'assistant' && assistant.streamedText).toBe('the answer');
  });
});
