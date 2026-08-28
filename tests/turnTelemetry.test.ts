/**
 * What a turn records about itself.
 *
 * Two gaps this closes, both of which were invisible rather than wrong:
 *
 *  - **No timing measurement existed anywhere.** `grep web-vitals|PerformanceObserver|performance.mark`
 *    returned nothing, so the client half of a turn — pressed Send, first byte, answer settled —
 *    was unmeasured. The service's own turn span cannot see any of it, and that triple is what
 *    answers "is it the frontend or the backend?".
 *  - **Dropped frames were uncounted.** Tolerating one malformed frame and ignoring one unknown
 *    event type are both correct and both pinned by other tests — but "one bad frame" and "every
 *    frame is unreadable" were the same observation, so a version skew against a newer service was
 *    silent by construction.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logger } from '../src/lib/logger.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import { sendMessage } from '../src/state/sendMessage.ts';
import type { AuthProvider } from '../src/auth/types.ts';
import { answerEvent, sseFrames, sseResponse, stubFetch } from './helpers.ts';

const SESSION = 'a'.repeat(32);

const devAuth: AuthProvider = {
  mode: 'dev',
  account: null,
  getAccessToken: async () => null,
  login: async () => undefined,
  logout: async () => undefined,
  handleUnauthorized: async () => false,
};

let restore: (() => void) | null = null;

const session = (): Response =>
  new Response(JSON.stringify({ session_id: SESSION }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** The newest entry with this name, or `undefined`. */
const entry = (message: string) => logger.snapshot().findLast((e) => e.message === message);

beforeEach(() => {
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
  restore?.();
  restore = null;
});

describe('turn timing', () => {
  it('records send → first token → answer, and how the turn ended', async () => {
    const stub = stubFetch((url) =>
      url.endsWith('/sessions')
        ? session()
        : sseResponse(sseFrames([{ type: 'token', text: 'ok' }, answerEvent({ text: 'ok' })])),
    );
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    await sendMessage({ conversationId: cid, text: 'pKa?', auth: devAuth });

    const timing = entry('turn.timing');
    expect(timing?.context?.outcome).toBe('done');
    expect(typeof timing?.context?.firstTokenMs).toBe('number');
    expect(typeof timing?.context?.answerMs).toBe('number');
    expect(typeof timing?.context?.totalMs).toBe('number');
    // Stamped with the session, which is what makes the number joinable to the service's own.
    expect(timing?.sessionId).toBe(SESSION);
  });

  it('records a turn that never produced a token, with the null saying so', async () => {
    const stub = stubFetch((url) =>
      url.endsWith('/sessions') ? session() : sseResponse(sseFrames([answerEvent({ text: 'x' })])),
    );
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    await sendMessage({ conversationId: cid, text: 'pKa?', auth: devAuth });

    // Null rather than 0: "no token ever arrived" and "the first token arrived instantly" are
    // different facts, and only one of them is interesting.
    expect(entry('turn.timing')?.context?.firstTokenMs).toBeNull();
  });
});

describe('frames this build could not use', () => {
  it('counts them and names the types, once, at the end of the turn', async () => {
    const body =
      'event: token\ndata: {not json at all\n\n' +
      'event: brand_new\ndata: {"type":"brand_new","x":1}\n\n' +
      sseFrames([answerEvent({ text: 'ok' })]);
    const stub = stubFetch((url) => (url.endsWith('/sessions') ? session() : sseResponse(body)));
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    await sendMessage({ conversationId: cid, text: 'pKa?', auth: devAuth });

    const dropped = entry('stream.frames_dropped');
    expect(dropped?.context).toMatchObject({ malformed: 1, unknown: 1 });
    // The type name is the whole point: it is what tells whoever reads this WHICH event a newer
    // service is sending that this build cannot render.
    expect(dropped?.context?.types).toContain('brand_new');

    // And the turn still delivered its answer, which is why both drops are correct behaviour.
    const message = useChatStore.getState().conversations[cid]?.messages.at(-1);
    expect(message?.role === 'assistant' && message.status).toBe('done');
  });

  it('says nothing about a turn where every frame was understood', async () => {
    const stub = stubFetch((url) =>
      url.endsWith('/sessions') ? session() : sseResponse(sseFrames([answerEvent({ text: 'ok' })])),
    );
    restore = stub.restore;

    const before = logger.snapshot().filter((e) => e.message === 'stream.frames_dropped').length;
    const cid = useChatStore.getState().createConversation();
    await sendMessage({ conversationId: cid, text: 'pKa?', auth: devAuth });

    expect(logger.snapshot().filter((e) => e.message === 'stream.frames_dropped')).toHaveLength(
      before,
    );
  });
});

describe('a tool that failed', () => {
  it('is recorded with its name, so it reaches somebody outside this tab', async () => {
    const body = sseFrames([
      { type: 'tool_failed', tool: 'predict_pka', message: 'connector timed out' },
      answerEvent({ text: 'ok' }),
    ]);
    const stub = stubFetch((url) => (url.endsWith('/sessions') ? session() : sseResponse(body)));
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    await sendMessage({ conversationId: cid, text: 'pKa?', auth: devAuth });

    expect(entry('tool.failed')?.context).toMatchObject({
      tool: 'predict_pka',
      // A plan-gate refusal is the control working; an ordinary failure is not. They must not read
      // the same in a log any more than they do on screen.
      reason: 'error',
    });
  });
});
