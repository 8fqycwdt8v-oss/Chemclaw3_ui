/**
 * What a tab nobody is looking at holds open.
 *
 * Each job push-back stream is a socket in the BFF's upstream pool, a slot in the service's per-pod
 * stream cap, and a claim transaction against the service's Postgres pool every 2 s for as long as
 * it is open. Three per tab at 200 chemists is 600 held connections and ~300 claim transactions a
 * second — and this hook had no visibility gating at all, so a tab behind another window on a
 * second monitor cost exactly as much as the one being read.
 *
 * The narrowing is deliberately to **one** rather than to zero, and these tests pin that as a
 * decision rather than as an accident: this module exists to deliver a completion that lands while
 * the chemist is somewhere else, so a hidden tab that watches nothing would raise its desktop
 * notification at the moment the chemist looks at the tab — which is the moment it stops being
 * worth having.
 *
 * The grace period is the other half. Without it an alt-tab tears down three streams and rebuilds
 * them seconds later, and 200 chemists coming back at 09:00 reopen 600 at once: a saving turned
 * into connection churn.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useChatStore } from '../src/state/chatStore.ts';
import { useJobStreams } from '../src/hooks/useJobStreams.ts';
import type { AuthProvider } from '../src/auth/types.ts';

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

/** Sessions with a stream open right now — the number this whole file is about. */
let live = new Set<string>();
let restore: (() => void) | null = null;

/** Streams that connect and then stay silent for ever, which is the healthy steady state here. */
function stubHeldStreams(): void {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const session = /sessions\/([0-9a-f]+)\/events/.exec(String(url))?.[1] ?? '';
    live.add(session);
    init?.signal?.addEventListener('abort', () => live.delete(session));
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(': open\n\n'));
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

/** Three conversations that have all been sent in, so all three are watchable. */
function watchThreeSessions(): void {
  const conversation = (id: string, session: string, updatedAt: number) =>
    ({
      id,
      sessionId: session,
      title: id,
      messages: [{ id: `m-${id}`, role: 'user', text: 'hi' }],
      updatedAt,
    }) as never;
  useChatStore.setState({
    conversations: {
      c1: conversation('c1', 'a'.repeat(32), 3),
      c2: conversation('c2', 'b'.repeat(32), 2),
      c3: conversation('c3', 'c'.repeat(32), 1),
    },
    activeId: 'c1',
    jobStreamsThrottled: false,
    jobStreamsFailing: [],
  });
}

/** Set `document.hidden`/`visibilityState` and fire the event the browser fires with them. */
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
  Object.defineProperty(document, 'visibilityState', {
    value: hidden ? 'hidden' : 'visible',
    configurable: true,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  live = new Set();
  setHidden(false);
  stubHeldStreams();
});

afterEach(() => {
  restore?.();
  restore = null;
  setHidden(false);
  vi.useRealTimers();
});

describe('a tab in the foreground', () => {
  it('watches the full budget', async () => {
    watchThreeSessions();
    const { unmount } = renderHook(() => useJobStreams());

    await vi.waitFor(() => expect(live.size).toBe(3));
    unmount();
  });
});

describe('a tab that has been hidden for a while', () => {
  it('drops to a single stream, and not to none', async () => {
    watchThreeSessions();
    const { unmount } = renderHook(() => useJobStreams());
    await vi.waitFor(() => expect(live.size).toBe(3));

    // The grace period is half a minute of wall clock, which is not a thing to make a test wait
    // out. `shouldAdvanceTime` keeps the real clock running underneath, so the awaits above and
    // below still resolve.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setHidden(true);
    await vi.advanceTimersByTimeAsync(31_000);

    // Before: three, for the life of the page, whatever the tab was doing.
    await vi.waitFor(() => expect(live.size).toBe(1));

    // One rather than zero: a job completion is worth *more* to a hidden tab than to a visible
    // one, and `notifyOnJobComplete` is what carries it.
    expect(live.size).toBe(1);
    unmount();
  }, 60_000);

  it('does not shed streams for a glance at another window', async () => {
    watchThreeSessions();
    const { unmount } = renderHook(() => useJobStreams());
    await vi.waitFor(() => expect(live.size).toBe(3));

    setHidden(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    setHidden(false);
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Nothing was torn down and nothing was reopened: the grace period is what keeps this from
    // being churn rather than a saving.
    expect(live.size).toBe(3);
    unmount();
  }, 20_000);
});
