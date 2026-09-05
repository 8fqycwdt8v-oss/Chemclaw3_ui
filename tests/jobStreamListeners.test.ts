/**
 * The retry loop's `sleep` must not accumulate abort listeners on a signal that outlives it.
 *
 * `{ once: true }` removes a listener when the event FIRES, and on the ordinary path it never
 * does: the timer wins the race, the promise resolves, and the listener stays attached — to the
 * stream's `AbortController.signal`, which lives for as long as the watch set does. Every retry
 * adds one more, each retaining its closure and its timer id.
 *
 * Measured on a stream held at the 15-30 s backoff cap for 12 simulated hours, before the fix:
 * **1,931 `abort` listeners added, 0 removed**. That is one of the three streams a tab holds, in
 * an app a chemist leaves open across a shift. Afterwards, over the same run: 1,911 added, 1,910
 * removed — the one outstanding is the sleep still in flight when the hook unmounts, which
 * resolves through the abort itself.
 *
 * The count is taken by wrapping `addEventListener`/`removeEventListener` on the signals the hook
 * constructs, rather than by reading the DOM implementation's own bookkeeping: what is being
 * asserted is what this code does, and happy-dom's internals are not part of that contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { AuthProvider } from '../src/auth/types.ts';

const SID = 'a'.repeat(32);

let restore: (() => void) | null = null;
let connects = 0;
let added = 0;
let removed = 0;

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

const OriginalController = globalThis.AbortController;

/** Count every `abort` registration and removal on the signals the hook opens. */
function countAbortListeners(): void {
  class Counting extends OriginalController {
    constructor() {
      super();
      const signal = this.signal;
      const add = signal.addEventListener.bind(signal);
      const remove = signal.removeEventListener.bind(signal);
      Object.defineProperty(signal, 'addEventListener', {
        value: (type: string, ...rest: [never, never]) => {
          if (type === 'abort') added += 1;
          add(type, ...rest);
        },
      });
      Object.defineProperty(signal, 'removeEventListener', {
        value: (type: string, ...rest: [never, never]) => {
          if (type === 'abort') removed += 1;
          remove(type, ...rest);
        },
      });
    }
  }
  globalThis.AbortController = Counting as unknown as typeof AbortController;
}

/** A stream the server refuses outright, for ever — the path that sits at the backoff cap. */
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

/**
 * The hook and the store from ONE module graph — `vi.resetModules()` below means a dynamically
 * imported hook gets a fresh `chatStore`, so seeding through a file-level import would write to a
 * store nothing under test is reading.
 */
async function load() {
  const { useJobStreams } = await import('../src/hooks/useJobStreams.ts');
  const { useChatStore } = await import('../src/state/chatStore.ts');
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
  return useJobStreams;
}

beforeEach(() => {
  connects = 0;
  added = 0;
  removed = 0;
  stubAlwaysFailing();
});

afterEach(() => {
  restore?.();
  restore = null;
  globalThis.AbortController = OriginalController;
  vi.resetModules();
});

describe('a stream retrying across a long outage', () => {
  it('does not retain one abort listener per retry', async () => {
    const useJobStreams = await load();
    // Instrumented after the imports so only the hook's own controllers are counted.
    countAbortListeners();
    // Fake timers after the dynamic import: it does not settle under them.
    vi.useFakeTimers();
    try {
      const { unmount } = renderHook(() => useJobStreams());

      await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1_000);

      // The measurement's shape: hundreds of retries, one sleep per retry.
      expect(connects).toBeGreaterThan(500);
      expect(added).toBeGreaterThan(500);

      // At most one outstanding — the sleep currently in flight. Before the fix this was every
      // one of them: 1,931 added against 0 removed.
      expect(added - removed).toBeLessThanOrEqual(1);

      unmount();
      // And the abort that tears the stream down settles that last one too.
      expect(added - removed).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
