/**
 * The push-back stream's 429 is not always the stream cap, and treating it as one is expensive.
 *
 * `openStream` reads 429 as "this tab holds more streams than its share of
 * `service_max_event_streams_per_user`", and a second one in a row drops the tab to a single
 * stream for the life of the page — deliberately irreversible, because oscillating against
 * whatever else holds the cap is worse than staying low.
 *
 * But the per-principal request limiter (`api/auth.py::_within_budget`) refuses with the same
 * status from inside `require_principal`, which every authenticated route funnels through — this
 * one included. That refusal is about the account's request rate over the last few seconds, not
 * about how many streams are open, and it says when to come back in `Retry-After`. Read as the
 * cap it is not, it cost the tab two thirds of its job notifications until a reload, and the wait
 * it asked for (seconds) was served by the cap's own backoff (15–30 s) instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useChatStore } from '../src/state/chatStore.ts';
import { useJobStreams } from '../src/hooks/useJobStreams.ts';
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

/** Every connect refused by the limiter, with the one-second wait it computed. */
function stubRateLimited(headers: Record<string, string>): void {
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    connects += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ detail: 'too many requests' }), {
        status: 429,
        headers: { 'content-type': 'application/json', ...headers },
      }),
    );
  }) as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
}

function watchOneSession(): { unmount: () => void } {
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
  return renderHook(() => useJobStreams());
}

beforeEach(() => {
  connects = 0;
});

afterEach(() => {
  restore?.();
  restore = null;
});

describe('a 429 that carries Retry-After', () => {
  it('is waited out for the stated time, and does not spend the tab’s stream budget', async () => {
    stubRateLimited({ 'retry-after': '1' });
    const { unmount } = watchOneSession();

    // Long enough for the one-second wait to elapse and reconnect, far short of the cap's own
    // 15–30 s backoff — which is what makes the count the assertion.
    await new Promise((resolve) => setTimeout(resolve, 1_400));
    unmount();

    expect(connects).toBeGreaterThanOrEqual(2);
    // And the two assertions belong together: two refusals in a row is exactly what permanently
    // drops this tab to one stream, so the flag is only meaningful once the reconnect above has
    // been shown to happen. A rate limit is not evidence of an over-subscribed cap, and it is the
    // one 429 here that recovers on its own.
    expect(useChatStore.getState().jobStreamsThrottled).toBe(false);
  });
});

/**
 * Honouring the header is right. Honouring it silently and for ever was not.
 *
 * That branch touched neither `failed()` nor `attempt` and did not log, so it was the one retry
 * path in this hook with no counter, no escalation and no indicator behind it. A limiter refusing
 * steadily — plausibly *because* this tab keeps coming back at exactly the rate it asked for —
 * simply carried on. Measured over 120 s of one stream at `Retry-After: 1`: **121 requests,
 * `jobStreamsFailing` empty**, and that is one of the three streams a tab holds.
 *
 * Afterwards, over the same 120 s: **9 requests**, the indicator raised. The ceiling is the same
 * `FAILURES_BEFORE_REPORTING` every other failure here uses, and past it the header stops being
 * taken at face value — a limiter that has refused four times running is not describing a queue
 * that clears in a second.
 */
describe('a 429 that keeps carrying Retry-After', () => {
  it('is counted and escalated rather than retried in silence for ever', async () => {
    stubRateLimited({ 'retry-after': '1' });
    const { unmount } = watchOneSession();
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(120_000);

      // The old loop ran at the rate the header asked for, indefinitely. Ten leaves ample room
      // for the backoff's jitter while staying an order of magnitude under 121.
      expect(connects).toBeLessThanOrEqual(10);
      expect(useChatStore.getState().jobStreamsFailing).toEqual([SID]);
      // Still not the stream cap. That flag is irreversible for the life of the page and means
      // "this tab holds more streams than its share" — a request-rate refusal is no evidence of
      // it, and the test above pins the same thing over the first two refusals.
      expect(useChatStore.getState().jobStreamsThrottled).toBe(false);
    } finally {
      vi.useRealTimers();
      unmount();
    }
  });
});

describe('a 429 that carries no Retry-After', () => {
  it('is still read as the concurrent-stream cap', async () => {
    stubRateLimited({});
    const { unmount } = watchOneSession();

    // One connect is all this window buys: the cap's backoff is 15–30 s, so the second refusal —
    // the one that sets the flag — is deliberately out of reach here. What is checked is that the
    // client did not treat a header-less 429 as a one-second pause.
    await new Promise((resolve) => setTimeout(resolve, 1_400));
    unmount();

    expect(connects).toBe(1);
  });
});
