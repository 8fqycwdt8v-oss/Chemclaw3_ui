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
