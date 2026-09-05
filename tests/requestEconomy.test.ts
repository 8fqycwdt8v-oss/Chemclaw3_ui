/**
 * Two reads this app made more often than it needed to.
 *
 * Neither is a bug in the sense of a wrong answer, which is why both survived: every component
 * involved fetched correctly, cancelled correctly and rendered correctly. What none of them could
 * see is each other.
 *
 * **`GET /plans/pending`** is the most expensive thing one navigation here can trigger. The service
 * scans up to `service_max_plan_scans` (25) sessions and its own route docstring says each read "is
 * a statement on a checkpointer that serializes them against every concurrent turn on the pod".
 * `ReviewQueue` mounted it on every visit to `/review`, so a chemist bouncing between the inbox and
 * a conversation paid for the whole scan each time.
 *
 * **A content-addressed read** — one tool result, one note — is immutable by construction, and this
 * client was doing the two things that follow from that backwards: `cache: 'no-store'` on every
 * request (which does not skip the cache, it forbids writing to it, so a remount refetched the
 * whole payload), and no join between concurrent readers, so the result block under an answer and
 * the trace panel behind it each fetched the same bytes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, resetPendingPlansCache } from '../src/api/client.ts';
import { stubFetch } from './helpers.ts';

const token = async (): Promise<string | null> => null;
const SESSION = 'a'.repeat(32);

/** Every request the client made, in order, with the caching directive it carried. */
let calls: { url: string; cache?: RequestCache }[] = [];
let restore: (() => void) | null = null;

/** Answers anything with an empty JSON object, and remembers being asked. */
function countingStub(): void {
  const stub = stubFetch((url, init) => {
    calls.push({ url, cache: init?.cache });
    const body = url.includes('/plans/pending') ? { plans: [], unread: 0 } : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  restore = stub.restore;
}

const pendingPlanCalls = (): number => calls.filter((c) => c.url.includes('/plans/pending')).length;

beforeEach(() => {
  calls = [];
  resetPendingPlansCache();
  countingStub();
});

afterEach(() => {
  restore?.();
  restore = null;
  vi.useRealTimers();
});

describe('the plan inbox', () => {
  it('is not rescanned when the reader bounces back into /review', async () => {
    await api.listPendingPlans(token);
    await api.listPendingPlans(token);
    await api.listPendingPlans(token);

    // Before: three scans, each up to 25 checkpointer reads serialized against every concurrent
    // turn on the pod.
    expect(pendingPlanCalls()).toBe(1);
  });

  it('is rescanned once the interval has passed, because it is a minimum interval and not a cache', async () => {
    vi.useFakeTimers();
    await api.listPendingPlans(token);
    await vi.advanceTimersByTimeAsync(11_000);
    await api.listPendingPlans(token);

    expect(pendingPlanCalls()).toBe(2);
  });

  it('is rescanned at once after a decision, which is the one act that invalidates it', async () => {
    await api.listPendingPlans(token);
    await api.decidePlan(SESSION, true, 'plan-hash', token);
    await api.listPendingPlans(token);

    // A decided plan must not sit in the inbox for the rest of the interval: the reader just acted
    // on it and is looking straight at the list.
    expect(pendingPlanCalls()).toBe(2);
  });
});

describe('a content-addressed read', () => {
  it('joins concurrent readers of the same bytes into one request', async () => {
    // The answer's result block and the trace panel behind it, citing one `result_ref`.
    const [a, b] = await Promise.all([
      api.getToolResult(SESSION, 'r'.repeat(16), token),
      api.getToolResult(SESSION, 'r'.repeat(16), token),
    ]);

    expect(calls).toHaveLength(1);
    // And both callers got the answer, rather than one of them getting nothing.
    expect(a).toEqual(b);
  });

  it('does not join two different refs', async () => {
    await Promise.all([
      api.getToolResult(SESSION, 'r'.repeat(16), token),
      api.getToolResult(SESSION, 's'.repeat(16), token),
    ]);
    expect(calls).toHaveLength(2);
  });

  it('lets the browser keep it, where every other route may not', async () => {
    await api.getToolResult(SESSION, 'r'.repeat(16), token);
    await api.listSessions(token);

    // `no-store` is not "bypass the cache", it is "never write to it" — which is right for a
    // session list and exactly wrong for a URL that changes whenever its bytes do.
    expect(calls[0]?.cache).toBe('default');
    expect(calls[1]?.cache).toBe('no-store');
  });
});
