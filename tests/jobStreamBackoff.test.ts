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
    });
    const { unmount } = renderHook(() => useJobStreams());

    // The window the measurement used. The first backoff is 1–2 s, so a paced client connects
    // once here and waits; the tight loop managed 200.
    await new Promise((resolve) => setTimeout(resolve, 300));
    unmount();

    expect(connects).toBeLessThanOrEqual(2);
  });
});
