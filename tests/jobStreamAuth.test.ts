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

/** Answer each request with the next status in `statuses`, repeating the last one forever. */
function stub(): void {
  const original = globalThis.fetch;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(init);
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
  });
  mounted = renderHook(() => useJobStreams()).unmount;
  // One macrotask is enough for the stream's first request and its synchronous follow-up; a
  // backoff would not have elapsed, which is the point of counting requests rather than waiting.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
  requests = [];
  statuses = [401];
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
});
