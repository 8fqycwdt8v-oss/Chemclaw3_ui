/**
 * A push-back stream the server closes cleanly must be reconnected at a *pace*.
 *
 * `openStream` only calls `backoff` on a non-OK status, a 429, or a thrown fetch. A
 * `200 text/event-stream` whose body simply ends — a backend pod restarting mid-rollout, a proxy
 * hop closing the connection, an upstream error after the headers — falls out of the read loop and
 * re-enters the `while` with no delay at all, and `attempt` has already been reset to 0 on connect
 * so the escalation never starts either.
 *
 * Measured before the fix, with a body that closes immediately: **200 connects in 286 ms**, from
 * one of the three streams a tab holds, times every open tab. The same loop starved a
 * `setTimeout(300)` outright, so the tab's main thread went with it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useChatStore } from '../src/state/chatStore.ts';
import type { AuthProvider } from '../src/auth/types.ts';

const SID = 'a'.repeat(32);

let restore: (() => void) | null = null;
let connects = 0;

const auth: AuthProvider = {
  mode: 'dev',
  account: null,
  getAccessToken: async () => null,
  login: async () => undefined,
  logout: async () => undefined,
  handleUnauthorized: async () => false,
};

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth, ready: true, revision: 0, refresh: () => {} }),
}));

/**
 * A healthy connect whose body then ends at once — no error, no bad status, nothing to retry on.
 *
 * It stops answering after `LIMIT` connects and never resolves again, which is what makes this
 *testable at all: the unpaced loop is CPU-bound and starves every timer in the tab, so a test
 * that simply waited would wait for ever rather than fail.
 */
const LIMIT = 200;

function stubImmediateClose(): void {
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    connects += 1;
    if (connects >= LIMIT) return new Promise<Response>(() => {});
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    );
  }) as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
}

/** A stream the server refuses outright, for ever. The other half of the same hazard. */
function stubAlwaysFailing(): void {
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    connects += 1;
    return Promise.resolve(new Response('nope', { status: 502 }));
  }) as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
}

const watchOneSession = (): void => {
  useChatStore.setState({
    conversations: {
      c1: {
        id: 'c1',
        sessionId: SID,
        title: 'x',
        messages: [{ id: 'm1', role: 'user', text: 'hi' }],
        updatedAt: 1,
      } as never,
    },
    activeId: 'c1',
    jobStreamsThrottled: false,
    jobStreamsFailing: [],
  });
};

beforeEach(() => {
  connects = 0;
  stubImmediateClose();
});

afterEach(() => {
  restore?.();
  restore = null;
  vi.resetModules();
});

describe('a stream the server closes cleanly', () => {
  it('is reconnected with a backoff rather than in a tight loop', async () => {
    const { useJobStreams } = await import('../src/hooks/useJobStreams.ts');
    watchOneSession();
    const { unmount } = renderHook(() => useJobStreams());

    // The window the measurement used. The first backoff is 1–2 s, so a paced client connects
    // once here and waits; the tight loop managed 200.
    await new Promise((resolve) => setTimeout(resolve, 300));
    unmount();

    expect(connects).toBeLessThanOrEqual(2);
  });
});

/**
 * The failure the module docstring named and the code did not act on.
 *
 * It says, at the 429 branch, that "a silent retry loop is exactly how this failure hides" — and
 * then only the 429 branch said anything. A 500, a 502, a TLS failure and a DNS failure all fell
 * into two identical silent branches: an infinite retry, capped at 30 s, with no banner, no
 * counter, no log and no store flag. Durable job completions quietly stopped arriving and nothing
 * recorded that they had.
 */
describe('a stream that keeps failing to connect', () => {
  beforeEach(() => {
    restore?.();
    connects = 0;
    stubAlwaysFailing();
  });

  /**
   * The hook and the store from ONE module graph.
   *
   * `vi.resetModules()` in the afterEach above means a dynamically imported hook gets a fresh
   * `chatStore` — so setting state through this file's top-level import would write to a store
   * nothing under test is reading, and the hook would watch nothing at all.
   */
  const load = async () => {
    const { useJobStreams } = await import('../src/hooks/useJobStreams.ts');
    const { useChatStore: store } = await import('../src/state/chatStore.ts');
    store.setState({
      conversations: {
        c1: {
          id: 'c1',
          sessionId: SID,
          title: 'x',
          messages: [{ id: 'm1', role: 'user', text: 'hi' }],
          updatedAt: 1,
        } as never,
      },
      activeId: 'c1',
      jobStreamsThrottled: false,
      jobStreamsFailing: [],
    });
    return { useJobStreams, store };
  };

  it('is reported after several attempts instead of retrying in silence for ever', async () => {
    const { useJobStreams, store } = await load();
    // Fake timers AFTER the imports: a dynamic import does not settle under them.
    vi.useFakeTimers();
    try {
      const { unmount } = renderHook(() => useJobStreams());

      // Past the fourth attempt the backoff has already spent about half a minute, which is the
      // point at which "the service is redeploying" stops being the likely explanation.
      await vi.advanceTimersByTimeAsync(60_000);

      expect(connects).toBeGreaterThanOrEqual(4);
      expect(store.getState().jobStreamsFailing).toEqual([SID]);

      unmount();
      // A stream nobody is watching cannot be failing — otherwise the indicator would outlive the
      // conversation that raised it.
      expect(store.getState().jobStreamsFailing).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says nothing about the first failure or two — a rollout is not an outage', async () => {
    const { useJobStreams, store } = await load();
    vi.useFakeTimers();
    try {
      const { unmount } = renderHook(() => useJobStreams());

      // One backoff's worth: two attempts at most, well under the threshold.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(store.getState().jobStreamsFailing).toEqual([]);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
