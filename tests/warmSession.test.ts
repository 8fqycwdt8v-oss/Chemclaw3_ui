/**
 * Minting the session while the chemist is still typing.
 *
 * The first message costs two sequential round-trips — `POST /sessions`, then `POST /messages` —
 * with the user's bubble and a spinner already on screen for both. Warming hides the first one.
 *
 * What it also introduces is a race that did not exist when only the send path created sessions:
 * a keystroke and a send, or two keystrokes under StrictMode's double-invoke, both arriving
 * before either finishes. Two backend sessions get minted and the store ends up pointing at the
 * one the in-flight turn is NOT using — the whole conversation's context, silently detached, with
 * nothing to flag it. These tests are about that.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '../src/state/chatStore.ts';
import { sendMessage, warmSession } from '../src/state/sendMessage.ts';
import type { AuthProvider } from '../src/auth/types.ts';
import { sseFrames, sseResponse, stubFetch } from './helpers.ts';

const devAuth: AuthProvider = {
  mode: 'dev',
  account: null,
  getAccessToken: async () => null,
  login: async () => undefined,
  logout: async () => undefined,
  handleUnauthorized: async () => false,
};

const ANSWER = sseFrames([
  { type: 'answer', text: 'ok', confidence: null, unsupported_claims: [], review_required: false },
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

describe('setSessionIdIfAbsent', () => {
  it('returns the id already in the store rather than overwriting it', () => {
    const cid = useChatStore.getState().createConversation();
    const first = 'a'.repeat(32);
    const second = 'b'.repeat(32);

    expect(useChatStore.getState().setSessionIdIfAbsent(cid, first)).toBe(first);
    // The second caller is told the winner. Returning its own id is the sharp failure: the caller
    // binds a turn to a session the store does not know about.
    expect(useChatStore.getState().setSessionIdIfAbsent(cid, second)).toBe(first);
    expect(useChatStore.getState().conversations[cid]?.sessionId).toBe(first);
  });

  it('leaves the deliberate overwrites alone', () => {
    // `session_not_found` recovery and `resetSession` must clobber — they exist precisely because
    // the old id is dead. Only the speculative path compares and sets.
    const cid = useChatStore.getState().createConversation();
    useChatStore.getState().setSessionIdIfAbsent(cid, 'a'.repeat(32));
    useChatStore.getState().setSessionId(cid, 'b'.repeat(32));
    expect(useChatStore.getState().conversations[cid]?.sessionId).toBe('b'.repeat(32));
  });
});

describe('warmSession', () => {
  it('creates the session once, however many keystrokes arrive', async () => {
    let created = 0;
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        created += 1;
        return new Response(JSON.stringify({ session_id: String(created).padStart(32, '0') }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
    });
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    warmSession(cid, devAuth);
    warmSession(cid, devAuth);
    warmSession(cid, devAuth);
    await new Promise((r) => setTimeout(r, 0));

    expect(created).toBe(1);
    expect(useChatStore.getState().conversations[cid]?.sessionId).toBe('1'.padStart(32, '0'));
  });

  it('the turn binds to the warmed session instead of minting a second one', async () => {
    // The payoff, and the hazard: a send arriving while the warm is still in flight must await it,
    // not race it.
    let created = 0;
    let turnSession: string | null = null;
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        created += 1;
        return new Response(
          JSON.stringify({ session_id: String(created).repeat(32).slice(0, 32) }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      if (url.includes('/messages') && init?.method === 'POST') {
        turnSession = url.split('/sessions/')[1]?.split('/')[0] ?? null;
        return sseResponse(ANSWER);
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
    });
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    warmSession(cid, devAuth);
    await sendMessage({ conversationId: cid, text: 'What is the pKa?', auth: devAuth });

    expect(created).toBe(1);
    expect(turnSession).toBe('1'.repeat(32));
    expect(useChatStore.getState().conversations[cid]?.sessionId).toBe('1'.repeat(32));
  });

  it('does nothing once the conversation already has a session', async () => {
    const stub = stubFetch(() => {
      throw new Error('should not have been called');
    });
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    useChatStore.getState().setSessionId(cid, 'a'.repeat(32));
    warmSession(cid, devAuth);
    await new Promise((r) => setTimeout(r, 0));

    expect(stub.calls).toHaveLength(0);
  });

  it('stays silent when the speculative create fails', async () => {
    // It is a guess made on a keystroke. A banner for something the chemist never asked for, on a
    // conversation they may never send, is worse than the round-trip it was trying to save.
    const stub = stubFetch(
      () =>
        new Response(JSON.stringify({ detail: 'at capacity' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    );
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    warmSession(cid, devAuth);
    await new Promise((r) => setTimeout(r, 0));

    expect(useChatStore.getState().banner).toBeNull();
    expect(useChatStore.getState().conversations[cid]?.sessionId).toBeNull();
  });
});
