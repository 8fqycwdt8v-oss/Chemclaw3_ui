/**
 * Closing the tab mid-turn must cancel the turn, not merely stop watching it.
 *
 * A disconnect only *detaches* since `D-2026-08-27-a-disconnect-is-a-detach-not-a-stop`: the turn
 * runs to completion on the service's own pump, holding one of `service_max_concurrent_turns`
 * (8 per front-door process), a database connection and an LLM bill, for up to the 600 s wall
 * clock. Cancelling is a request, `POST /sessions/{id}/turn/stop`, and this app sent it from
 * exactly one place — the Stop button. So closing the tab, reloading, or navigating away left the
 * turn running for nobody, and two abandoned turns per pod is a quarter of its admission capacity.
 *
 * `grep -rn "beforeunload|pagehide" src/` found two handlers before this and both only saved local
 * state, which is precisely the shape of defect nothing else in this suite could see: the app was
 * correct in every path a test drove, and wrong in the one it never left.
 *
 * The three assertions are the three decisions:
 *   1. a discarded document cancels;
 *   2. a `pagehide` into the back/forward cache does **not**, because that document is coming back
 *      with its in-flight `fetch` intact and cancelling would destroy a turn the reader still
 *      wants;
 *   3. the request is `keepalive`, or the navigation that triggered it kills it on the way out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../src/state/chatStore.ts';
import { sendMessage } from '../src/state/sendMessage.ts';
import type { AuthProvider } from '../src/auth/types.ts';
import { sseFrames, stubFetch } from './helpers.ts';

const SESSION = 'g'.repeat(32);

const msalAuth: AuthProvider = {
  mode: 'msal',
  account: null,
  getAccessToken: async () => 'the-turn-token',
  login: async () => undefined,
  logout: async () => undefined,
  handleUnauthorized: async () => false,
};

/** Every stop request the page made, with the parts that decide whether it survives unload. */
let stops: { authorization?: string; keepalive?: boolean }[] = [];
let restore: (() => void) | null = null;

/**
 * A turn that has started streaming and will not finish on its own.
 *
 * The stream stays open, which is the state a reader closes the tab in — a turn that had already
 * settled has nothing to cancel.
 */
function startAnUnfinishedTurn(): void {
  const stub = stubFetch((url, init) => {
    if (url.endsWith('/sessions') && init?.method === 'POST') {
      return new Response(JSON.stringify({ session_id: SESSION }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/turn/stop')) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      stops.push({ authorization: headers.authorization, keepalive: init?.keepalive });
      return new Response(JSON.stringify({ stopped: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // The turn stream: one token, then silence for ever.
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(sseFrames([{ type: 'token', text: 'thinking' }])),
          );
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  });
  restore = stub.restore;
}

/**
 * Wait until there is a turn to cancel.
 *
 * The session id, not the `streaming` slot: `sendMessage` fills that slot *before* it mints the
 * session, so a tab closed in between has nothing running and `abandon` correctly sends nothing —
 * which is a real state and would make this test assert on the wrong instant.
 */
async function turnIsRunning(): Promise<void> {
  await vi.waitFor(() => {
    const state = useChatStore.getState();
    expect(state.streaming).not.toBeNull();
    expect(state.conversations[state.streaming?.conversationId ?? '']?.sessionId).toBe(SESSION);
  });
}

/** Fire the real event the browser fires, with the one field the decision turns on. */
function pagehide(persisted: boolean): void {
  const event = new Event('pagehide') as Event & { persisted?: boolean };
  Object.defineProperty(event, 'persisted', { value: persisted });
  window.dispatchEvent(event);
}

beforeEach(() => {
  stops = [];
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
  useChatStore.getState().streaming?.abort.abort();
  restore?.();
  restore = null;
  vi.useRealTimers();
});

describe('a tab that goes away mid-turn', () => {
  it('cancels the turn on the server', async () => {
    startAnUnfinishedTurn();
    const cid = useChatStore.getState().createConversation();
    void sendMessage({ conversationId: cid, text: 'pKa?', auth: msalAuth });
    await turnIsRunning();

    pagehide(false);
    await vi.waitFor(() => expect(stops.length).toBe(1));

    // Before: zero requests. The turn ran to its 600 s deadline for a reader who had gone.
    expect(stops[0]?.authorization).toBe('Bearer the-turn-token');
  }, 20_000);

  it('sends it with keepalive, or the navigation cancels the cancellation', async () => {
    startAnUnfinishedTurn();
    const cid = useChatStore.getState().createConversation();
    void sendMessage({ conversationId: cid, text: 'pKa?', auth: msalAuth });
    await turnIsRunning();

    pagehide(false);
    await vi.waitFor(() => expect(stops.length).toBe(1));

    // The same trick, and the same reason, as the log sink's final batch (`src/lib/logger.ts`).
    expect(stops[0]?.keepalive).toBe(true);
  }, 20_000);

  it('leaves the turn alone when the page is only going into the back/forward cache', async () => {
    startAnUnfinishedTurn();
    const cid = useChatStore.getState().createConversation();
    void sendMessage({ conversationId: cid, text: 'pKa?', auth: msalAuth });
    await turnIsRunning();

    pagehide(true);
    // Long enough for the request to have been made if it were going to be.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // `persisted: true` means this document, this store and this in-flight `fetch` are frozen and
    // may all be restored — the reader pressed Back, and is about to press Forward.
    expect(stops).toEqual([]);
  }, 20_000);
});
