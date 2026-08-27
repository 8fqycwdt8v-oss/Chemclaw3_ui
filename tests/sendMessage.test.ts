import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../src/state/chatStore.ts';
import { sendMessage } from '../src/state/sendMessage.ts';
import type { AuthProvider } from '../src/auth/types.ts';
import {
  answerEvent,
  brokenSseResponse,
  jsonError,
  sseFrames,
  sseResponse,
  stubFetch,
} from './helpers.ts';

const devAuth: AuthProvider = {
  mode: 'dev',
  account: null,
  getAccessToken: async () => null,
  login: async () => undefined,
  logout: async () => undefined,
  handleUnauthorized: async () => false,
};

/**
 * A provider whose token changes *because* it re-authenticated.
 *
 * Not a queue of tokens, deliberately. `api.createSession` takes a token of its own before the
 * turn ever runs, so a positional queue would hand the first attempt the value meant for the
 * second and the assertion below would pass on the wrong bytes. Keying the token off the refresh
 * having happened is also what a real provider does: the replay must carry the credential that
 * exists *after* `handleUnauthorized` resolved, not merely a second copy of the stale one.
 */
function reauthingAuth(recovers: boolean): AuthProvider & { asked: number } {
  return {
    mode: 'msal',
    account: null,
    asked: 0,
    refreshed: false,
    async getAccessToken() {
      return this.refreshed ? 'fresh' : 'stale';
    },
    async login() {},
    async logout() {},
    async handleUnauthorized() {
      this.asked += 1;
      if (recovers) this.refreshed = true;
      return recovers;
    },
  } as AuthProvider & { asked: number; refreshed: boolean };
}

const bearer = (init?: RequestInit): string | undefined =>
  (init?.headers as Record<string, string> | undefined)?.authorization;

const ANSWER = sseFrames([{ type: 'token', text: 'ok' }, answerEvent({ text: 'ok' })]);

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

  /**
   * A token that expires *inside* a conversation turn.
   *
   * `handleUnauthorized` has three callers: every `api.*` route (covered by
   * `tests/apiAuthRecovery.test.ts`), the job push-back stream (`tests/jobStreamAuth.test.ts`), and
   * this one — the only one a chemist actually sits in, since an Entra access token lives 60-90
   * minutes and a conversation outlives that. It was the one with no test, and deleting the
   * recovery branch from `sendMessage` left the whole suite green.
   */
  describe('a 401 arriving mid-turn', () => {
    /** Turn attempts, and the session POSTs, kept apart so "replayed once" can be asserted. */
    const stubTurn = (turnStatus: (attempt: number) => Response) => {
      const state = { turns: 0 };
      const stub = stubFetch((url, init) => {
        if (url.endsWith('/sessions') && init?.method === 'POST') {
          return new Response(JSON.stringify({ session_id: 'f'.repeat(32) }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        state.turns += 1;
        return turnStatus(state.turns);
      });
      restore = stub.restore;
      return { stub, state };
    };

    it('refreshes the token and replays the turn exactly once', async () => {
      const { stub, state } = stubTurn((n) =>
        n === 1 ? jsonError(401, 'invalid or expired token') : sseResponse(ANSWER),
      );
      const auth = reauthingAuth(true);

      const cid = useChatStore.getState().createConversation();
      await sendMessage({ conversationId: cid, text: 'hello', auth });

      expect(state.turns).toBe(2);
      expect(auth.asked).toBe(1);
      // The bytes that matter: a replay carrying the stale token satisfies a call-count assertion
      // and fixes nothing — the service would 401 it again.
      const turnCalls = stub.calls.filter((c) => c.url.endsWith('/messages'));
      expect(turnCalls.map((c) => bearer(c.init))).toEqual(['Bearer stale', 'Bearer fresh']);

      const conversation = useChatStore.getState().conversations[cid];
      // One user bubble and ONE assistant answer — the replay must reuse the message the first
      // attempt started, not append a second empty one beside it.
      expect(conversation?.messages).toHaveLength(2);
      expect(conversation?.messages[1]).toMatchObject({ role: 'assistant', status: 'done' });
      // Nothing to click, because nothing went wrong from the chemist's side.
      expect(useChatStore.getState().banner).toBeNull();
      expect(useChatStore.getState().composerLock).toBe(false);
      expect(useChatStore.getState().streaming).toBeNull();
      // The session handle is untouched: a 401 says who you are, not which session this is.
      expect(conversation?.contextLost).toBeFalsy();
    });

    it('gives up after one replay even when the provider claims to recover forever', async () => {
      // The bound that matters. Recovery is a boolean rather than a loop because a turn costs real
      // money and collides with the backend's per-session turn lock; a provider that always says
      // "recovered" must not be able to spend the budget in a spin.
      const { state } = stubTurn(() => jsonError(401, 'invalid or expired token'));
      const auth = reauthingAuth(true);

      const cid = useChatStore.getState().createConversation();
      await sendMessage({ conversationId: cid, text: 'hello', auth });

      expect(state.turns).toBe(2);
      expect(auth.asked).toBe(1);
      expect(useChatStore.getState().banner?.action).toBe('reauth');
      expect(useChatStore.getState().composerLock).toBe(false);
    });

    it('does not replay when recovery needs an interactive redirect', async () => {
      // `handleUnauthorized` resolving false means navigation is already under way, so a replay
      // would fire a doomed turn into a page that is leaving.
      const { state } = stubTurn(() => jsonError(401, 'invalid or expired token'));
      const auth = reauthingAuth(false);

      const cid = useChatStore.getState().createConversation();
      await sendMessage({ conversationId: cid, text: 'hello', auth });

      expect(state.turns).toBe(1);
      expect(auth.asked).toBe(1);
      expect(useChatStore.getState().banner?.action).toBe('reauth');
    });
  });

  /**
   * The turn-level half of "a dropped connection is not a Stop".
   *
   * `streamTurn` decides the *kind*; this is what a chemist sees because of it. The two outcomes
   * are deliberately different surfaces — a Stop is silent and keeps its partial text as something
   * you asked for, a break raises a banner — and nothing checked that the second one was reachable.
   */
  describe('the connection dropping mid-answer', () => {
    it('is reported as a failure once recovery gives up finding an answer', async () => {
      // A session exists, so the drop is no longer an instant failure
      // (`D-2026-08-27-a-disconnect-is-a-detach-not-a-stop`): the client polls
      // `GET /sessions/{id}/messages` for the detached turn's answer before giving up. This mock
      // never has one to serve, so the fake clock is what lets the test observe the eventual
      // failure without waiting out the real ~630 s deadline.
      vi.useFakeTimers();
      try {
        const stub = stubFetch((url, init) => {
          if (url.endsWith('/sessions') && init?.method === 'POST') {
            return new Response(JSON.stringify({ session_id: 'g'.repeat(32) }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          if (url.endsWith('/messages') && (init?.method ?? 'GET') === 'GET') {
            return new Response(JSON.stringify([]), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return brokenSseResponse(
            sseFrames([{ type: 'token', text: 'The pKa of acetic acid is ' }]),
          );
        });
        restore = stub.restore;

        const cid = useChatStore.getState().createConversation();
        const turn = sendMessage({ conversationId: cid, text: 'pKa?', auth: devAuth });
        await vi.advanceTimersByTimeAsync(630_000);
        await turn;

        const message = useChatStore.getState().conversations[cid]?.messages[1];
        expect(message).toMatchObject({ role: 'assistant', status: 'error' });
        // The half-answer is kept — the service did the work and it is the only copy on screen —
        // but it is kept as a *failure*, which is the distinction the banner below carries.
        expect(message && 'streamedText' in message && message.streamedText).toBe(
          'The pKa of acetic acid is ',
        );
        expect(message && 'error' in message && message.error?.kind).toBe('stream');

        // A Stop raises no banner at all. A banner is therefore the whole visible difference
        // between "your network died" and "you cancelled this", and it is what a relabelling
        // mutation removes.
        const banner = useChatStore.getState().banner;
        expect(banner?.kind).toBe('error');
        expect(useChatStore.getState().composerLock).toBe(false);
        expect(useChatStore.getState().streaming).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    }, 20_000);

    it('is told apart from the user pressing Stop on the same partial answer', async () => {
      // The control. Same partial text, same broken socket — but aborted, so no banner and the
      // message is marked as something the chemist chose.
      const stub = stubFetch((url, init) => {
        if (url.endsWith('/sessions') && init?.method === 'POST') {
          return new Response(JSON.stringify({ session_id: 'h'.repeat(32) }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return brokenSseResponse(
          sseFrames([{ type: 'token', text: 'The pKa of acetic acid is ' }]),
          new TypeError('network error'),
          () => useChatStore.getState().streaming?.abort.abort(),
        );
      });
      restore = stub.restore;

      const cid = useChatStore.getState().createConversation();
      await sendMessage({ conversationId: cid, text: 'pKa?', auth: devAuth });

      const message = useChatStore.getState().conversations[cid]?.messages[1];
      expect(message).toMatchObject({ role: 'assistant', status: 'aborted' });
      expect(useChatStore.getState().banner).toBeNull();
    });
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

describe('detach and stop (D-2026-08-27-a-disconnect-is-a-detach-not-a-stop)', () => {
  it('stopStreaming posts the explicit stop before aborting the stream', async () => {
    const { stopStreaming } = await import('../src/state/sendMessage.ts');
    let releaseStream: (() => void) | null = null;
    const hanging = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('event: token\ndata: {"type":"token","text":"hi"}\n\n'),
        );
        releaseStream = () => controller.close();
      },
    });
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ session_id: 'b'.repeat(32) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/turn/stop')) {
        // The server cancels the turn; the hanging stream then ends.
        releaseStream?.();
        return new Response(JSON.stringify({ stopped: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(hanging, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    const turn = sendMessage({ conversationId: cid, text: 'long question', auth: devAuth });
    // Wait until the first token has landed — the session exists and the stream is open — then
    // press Stop. Waiting only for `streaming` is too early: it is set before the session is
    // minted, and a stop with no session id degrades to the bare abort.
    const firstToken = () => {
      const message = useChatStore.getState().conversations[cid]?.messages.at(-1);
      return message?.role === 'assistant' && message.streamedText.length > 0;
    };
    while (!firstToken()) await new Promise((r) => setTimeout(r, 5));
    stopStreaming();
    await turn;

    expect(stub.calls.some((c) => c.url.endsWith('/turn/stop'))).toBe(true);
    const message = useChatStore.getState().conversations[cid]?.messages.at(-1);
    expect(message?.role === 'assistant' && message.status).toBe('aborted');
  });

  it('says the stop was not confirmed when the server refuses it, so the next 409 is expected', async () => {
    // `api.stopTurn` resolves `false` when there is no route and THROWS on a 500/503; both used to
    // be discarded with `.catch(() => undefined)`. The user was then reliably told "Stopped before
    // the answer was complete" while the turn kept running server-side — holding the session's
    // turn lock and spending budget — so their next message came back 409, which `sendMessage`
    // maps to a "reset" banner: an app bug to a chemist and nothing at all to an operator.
    const { stopStreaming } = await import('../src/state/sendMessage.ts');
    let releaseStream: (() => void) | null = null;
    const hanging = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('event: token\ndata: {"type":"token","text":"hi"}\n\n'),
        );
        releaseStream = () => controller.close();
      },
    });
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ session_id: 'c'.repeat(32) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/turn/stop')) {
        // The server cannot take the request. The local stream still ends, because Stop's local
        // half is unconditional — that part of the UX is right and is unchanged.
        releaseStream?.();
        return jsonError(503, 'at capacity');
      }
      return new Response(hanging, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    const turn = sendMessage({ conversationId: cid, text: 'long question', auth: devAuth });
    const firstToken = () => {
      const message = useChatStore.getState().conversations[cid]?.messages.at(-1);
      return message?.role === 'assistant' && message.streamedText.length > 0;
    };
    while (!firstToken()) await new Promise((r) => setTimeout(r, 5));
    stopStreaming();
    await turn;

    // The local stop still happened...
    const message = useChatStore.getState().conversations[cid]?.messages.at(-1);
    expect(message?.role === 'assistant' && message.status).toBe('aborted');
    // ...and the reader is told the server did not confirm it, which is what makes the 409 their
    // next message may get an expected consequence rather than a mystery.
    const banner = useChatStore.getState().banner;
    expect(banner?.kind).toBe('warn');
    expect(banner?.text).toContain('did not confirm');
  });

  it('a dropped stream recovers the answer from the transcript instead of failing the turn', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('event: token\ndata: {"type":"token","text":"part"}\n\n'),
        );
        controller.error(new Error('connection reset'));
      },
    });
    let polls = 0;
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ session_id: 'c'.repeat(32) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/messages') && (init?.method ?? 'GET') === 'GET') {
        polls += 1;
        // First poll: the detached turn has not committed yet. Second: the answer landed.
        const transcript =
          polls === 1
            ? []
            : [
                { index: 0, role: 'user', text: 'flaky network question', tool_calls: [] },
                { index: 1, role: 'assistant', text: 'the recovered answer', tool_calls: [] },
              ];
        return new Response(JSON.stringify(transcript), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(broken, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    await sendMessage({ conversationId: cid, text: 'flaky network question', auth: devAuth });

    const message = useChatStore.getState().conversations[cid]?.messages.at(-1);
    expect(message?.role === 'assistant' && message.finalText).toBe('the recovered answer');
    expect(useChatStore.getState().composerLock).toBe(false);
    expect(useChatStore.getState().banner).toBeNull();
  }, 20_000);
});
