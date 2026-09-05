/**
 * The job push-back stream stops on an unrecoverable 401 instead of retrying it forever.
 *
 * `openStream` treated every non-2xx alike: increment the attempt, back off, retry — unbounded, for
 * the life of the page, from each of the three streams every open tab holds. For a transport
 * failure that is right. For a 401 it is not, and the case is not hypothetical: a revoked token or
 * an audience that changed under a redeploy 401s every attempt forever, and the backend's
 * per-principal rate budget cannot damp it, because that budget lives *inside* `require_principal`
 * and only spends after validation succeeds.
 *
 * The stream is driven directly through a stubbed `fetch` rather than through React: the retry loop
 * is the subject, and rendering a component to reach it would make the timing of an effect part of
 * the test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { AuthProvider } from '../src/auth/types.ts';

const SID = 'a'.repeat(32);

let restore: (() => void) | null = null;
let statuses: number[] = [];
let requests: (RequestInit | undefined)[] = [];

/**
 * The 1-based request number that is answered with a working stream instead of `statuses`.
 *
 * A token expiring twice in one session cannot be written with statuses alone: what makes the
 * second 401 a *different* fact from the first is the healthy connection in between.
 */
let deliverOn: number | null = null;

/** Torn down in `afterEach`, so no test's hook is alive while the next one counts requests. */
let mounted: (() => void) | null = null;

/** The auth context the hook reads. Replaced per test so recovery can be dictated. */
let currentAuth: AuthProvider & { asked: number };

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: currentAuth, ready: true, revision: 0, refresh: () => {} }),
}));

function provider(recovers: boolean): AuthProvider & { asked: number } {
  return {
    mode: 'msal',
    account: null,
    asked: 0,
    async getAccessToken() {
      return 'a-token';
    },
    async login() {},
    async logout() {},
    async handleUnauthorized() {
      this.asked += 1;
      return recovers;
    },
  };
}

/**
 * One `200 text/event-stream` carrying a single completion, which then closes.
 *
 * A closing body is what the backend does on a rollout, and it is the ordinary shape of a
 * connection that worked: the point is only that a frame got through before it ended.
 */
function oneFrameThenClose(): Response {
  const body = `event: job_completed\ndata: ${JSON.stringify({
    type: 'job_completed',
    job_id: 'job-1',
    summary: { converged: true },
  })}\n\n`;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

/** Answer each request with the next status in `statuses`, repeating the last one forever. */
function stub(): void {
  const original = globalThis.fetch;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(init);
    if (requests.length === deliverOn) return Promise.resolve(oneFrameThenClose());
    const status = statuses[Math.min(requests.length - 1, statuses.length - 1)] ?? 401;
    return Promise.resolve(new Response(null, { status }));
  }) as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
}

/**
 * Drive the hook for one conversation with one message, which is what makes it watch a session.
 *
 * **The store is imported here, beside the hook, rather than at the top of the file.**
 * `afterEach` calls `vi.resetModules()`, so every test after the first gets a fresh module graph —
 * a fresh `useJobStreams` *and* a fresh `chatStore`. Seeding the file-level import therefore wrote
 * into a store the hook under test could not see, and its `watchKey` was empty: the requests the
 * second and third tests counted were fired by the **first test's hook, still mounted**, whose
 * effect re-ran because `currentAuth` had been swapped under it. Both tests passed while
 * exercising nothing, and the tell was that narrowing the hook's subscription — which cannot
 * affect a 401 — turned one of them red.
 *
 * So: same graph as the hook, and `unmount` below so a test's hook cannot outlive it.
 */
async function watch(): Promise<void> {
  await mount();
  // One macrotask is enough for the stream's first request and its synchronous follow-up; a
  // backoff would not have elapsed, which is the point of counting requests rather than waiting.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/** The same, without the wait, for a test that drives the clock itself. Returns the store the
 *  hook is actually reading — see the note above on `vi.resetModules()`. */
async function mount(): Promise<typeof import('../src/state/chatStore.ts').useChatStore> {
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
    jobFeed: [],
  });
  mounted = renderHook(() => useJobStreams()).unmount;
  return useChatStore;
}

beforeEach(() => {
  requests = [];
  statuses = [401];
  deliverOn = null;
  currentAuth = provider(false);
  stub();
});

afterEach(() => {
  mounted?.();
  mounted = null;
  restore?.();
  restore = null;
  vi.resetModules();
});

describe('a 401 on the push-back stream', () => {
  it('asks the provider to recover, once, and then stops', async () => {
    await watch();

    expect(currentAuth.asked).toBe(1);
    // One request, one refused recovery, no retry. Before this, the same 401 produced an
    // unbounded backoff loop that never stopped and never told anyone.
    expect(requests).toHaveLength(1);
  });

  it('reconnects when the provider does recover, and does not loop if that fails too', async () => {
    currentAuth = provider(true);
    await watch();

    // Two attempts: the original and one after a successful refresh. The second 401 is not asked
    // about again, because a refresh that did not help will not help twice.
    expect(requests).toHaveLength(2);
    expect(currentAuth.asked).toBe(1);
  });

  it('still carries the bearer on every attempt', async () => {
    currentAuth = provider(true);
    await watch();

    for (const init of requests) {
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer a-token');
    }
  });

  /**
   * The one that stops it saying nothing at all.
   *
   * Every other way this stream dies goes through `failed()`, which raises the sidebar indicator
   * after four attempts. The 401 `return` was the only terminus that did not — and it is the only
   * PERMANENT one, so the death mode with no recovery was the death mode with no signal. A
   * conformer search finishing afterwards produced no card, no badge and no notification.
   */
  it('says the stream is down when it gives up, rather than dying quietly', async () => {
    const store = await mount();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(requests).toHaveLength(1);
    expect(store.getState().jobStreamsFailing).toEqual([SID]);
  });
});

/**
 * A session outlives more than one access token, and the hook stopped at the first one.
 *
 * `reauthed` was set once per `openStream` call and never cleared, so the one-shot recovery was
 * spent per SESSION rather than per rejection. A stream that refreshed at 09:00, delivered for an
 * hour, and then met the ordinary next expiry took the `return` instead of the refresh —
 * permanently, for the life of the page.
 *
 * Measured against `401 → 200 (one job_completed frame, then close) → 401`: **requests 3,
 * provider asked 1, jobFeed 1, jobStreamsFailing []**. Afterwards: requests 4, asked 2.
 *
 * The back-to-back case above is a different fact and both must hold — a refresh that did not
 * help will not help twice, and that is still true here, which is why the run ends at four
 * requests rather than looping.
 */
describe('a second token expiry, an hour after the first', () => {
  it('is offered to the provider again, because the connection in between worked', async () => {
    currentAuth = provider(true);
    // 401, then a working stream, then 401 for ever.
    statuses = [401, 401, 401];
    deliverOn = 2;
    const store = await mount();

    // Fake timers AFTER the dynamic imports: an import does not settle under them. Sixty seconds
    // covers the single 1–2 s backoff the closing body earns between the two expiries.
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
    }

    expect(currentAuth.asked).toBe(2);
    expect(requests).toHaveLength(4);
    // The frame that got through is the evidence the connection worked at all.
    expect(store.getState().jobFeed).toHaveLength(1);
    // And the second expiry ends the stream for real, so it says so.
    expect(store.getState().jobStreamsFailing).toEqual([SID]);
  });
});
