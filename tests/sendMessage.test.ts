import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '../src/state/chatStore.ts';
import { sendMessage } from '../src/state/sendMessage.ts';
import type { AuthProvider } from '../src/auth/types.ts';
import { answerEvent, jsonError, sseFrames, sseResponse, stubFetch } from './helpers.ts';

const devAuth: AuthProvider = {
  mode: 'dev',
  account: null,
  getAccessToken: async () => null,
  login: async () => undefined,
  logout: async () => undefined,
  handleUnauthorized: async () => false,
};

const ANSWER = sseFrames([
  { type: 'token', text: 'ok' },
  answerEvent({ text: 'ok', confidence: null, unsupported_claims: [], review_required: false }),
]);

let restore: (() => void) | null = null;

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

describe('sendMessage', () => {
  it('creates a session, streams the turn, and releases the composer', async () => {
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ session_id: 'a'.repeat(32) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return sseResponse(ANSWER);
    });
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    await sendMessage({ conversationId: cid, text: 'hello', auth: devAuth });

    const conversation = useChatStore.getState().conversations[cid];
    expect(conversation?.sessionId).toBe('a'.repeat(32));
    expect(conversation?.messages).toHaveLength(2);
    expect(useChatStore.getState().composerLock).toBe(false);
    expect(useChatStore.getState().streaming).toBeNull();
  });

  it('recreates the session and replays exactly once on a 404', async () => {
    // A 404 means the handle is dead — unknown, someone else's, or evicted from the backend's
    // bounded live-session cache. Recovery must be bounded: retrying in a loop would spend real
    // money against a service that keeps saying no.
    let createCount = 0;
    let turnAttempts = 0;

    const stub = stubFetch((url, init) => {
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        createCount += 1;
        return new Response(JSON.stringify({ session_id: String(createCount).repeat(32) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      turnAttempts += 1;
      if (turnAttempts === 1) return jsonError(404, 'unknown session');
      return sseResponse(ANSWER);
    });
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    await sendMessage({ conversationId: cid, text: 'hello', auth: devAuth });

    expect(turnAttempts).toBe(2);
    expect(createCount).toBe(2);
    const conversation = useChatStore.getState().conversations[cid];
    // The transcript survived the session swap, but the agent's memory did not — and we say so.
    expect(conversation?.contextLost).toBe(true);
    expect(conversation?.messages).toHaveLength(2);
  });

  it('gives up after one recreate when the session keeps 404ing', async () => {
    let turnAttempts = 0;
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ session_id: 'c'.repeat(32) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      turnAttempts += 1;
      return jsonError(404, 'unknown session');
    });
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    await sendMessage({ conversationId: cid, text: 'hello', auth: devAuth });

    expect(turnAttempts).toBe(2); // original + one replay, then stop
    expect(useChatStore.getState().banner?.kind).toBe('error');
    expect(useChatStore.getState().composerLock).toBe(false);
  });

  it('locks the composer permanently on a 429 budget refusal', async () => {
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ session_id: 'd'.repeat(32) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return jsonError(429, 'session turn budget exhausted (50 turns)');
    });
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    await sendMessage({ conversationId: cid, text: 'hello', auth: devAuth });

    // The budget does not replenish on retry, so this is terminal rather than retryable.
    expect(useChatStore.getState().composerLock).toBe('budget_exhausted');
  });

  it('offers a session reset when the backend reports a turn already running', async () => {
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ session_id: 'e'.repeat(32) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return jsonError(409, 'a turn is already running for this session');
    });
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    await sendMessage({ conversationId: cid, text: 'hello', auth: devAuth });

    expect(useChatStore.getState().banner?.action).toBe('reset');
  });

  it('refuses to start a second turn while one is locked', async () => {
    const stub = stubFetch(() => sseResponse(ANSWER));
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    useChatStore.getState().setComposerLock('turn_in_flight');
    await sendMessage({ conversationId: cid, text: 'hello', auth: devAuth });

    expect(useChatStore.getState().conversations[cid]?.messages).toHaveLength(0);
    expect(stub.calls).toHaveLength(0);
  });
});
