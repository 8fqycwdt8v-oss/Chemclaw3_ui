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
 *
 * **What moved, and why this file now drives `queries.ts` instead of `api`.** Both economies used
 * to live inside `client.ts`, as a `Map<string, Promise>` of in-flight reads and a
 * `{ at, plans }` module variable, so calling `api.listPendingPlans` twice was the honest way to
 * drive them. Neither is the transport's job any more: a `queryKey` is the join *and* the cache the
 * join could never be, and the interval is a `staleTime` that a plan decision invalidates rather
 * than a window it has to wait out. So the assertions are unchanged and the subject is the read as
 * this app actually performs it — `queryClient.fetchQuery(pendingPlansQuery(token))` is exactly
 * what `PlanInbox` mounts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client.ts';
import { QueryObserver, focusManager } from '@tanstack/react-query';
import { queryClient, resetQueryCache } from '../src/api/queryClient.ts';
import { logger } from '../src/lib/logger.ts';
import { pendingPlansQuery, toolResultQuery } from '../src/api/queries.ts';
import { stubFetch } from './helpers.ts';

/** The plan inbox, read the way `PlanInbox` reads it. */
const readPendingPlans = (): Promise<unknown> => queryClient.fetchQuery(pendingPlansQuery(token));

/** One stored result, read the way `ResultBlock` and `ResultSheet` read it. */
const readToolResult = (ref: string): Promise<unknown> =>
  queryClient.fetchQuery(toolResultQuery(SESSION, ref, token));

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
  resetQueryCache();
  countingStub();
});

afterEach(() => {
  restore?.();
  restore = null;
  vi.useRealTimers();
});

describe('the plan inbox', () => {
  it('is not rescanned when the reader bounces back into /review', async () => {
    await readPendingPlans();
    await readPendingPlans();
    await readPendingPlans();

    // Before: three scans, each up to 25 checkpointer reads serialized against every concurrent
    // turn on the pod.
    expect(pendingPlanCalls()).toBe(1);
  });

  it('is rescanned once the interval has passed, because it is a minimum interval and not a cache', async () => {
    vi.useFakeTimers();
    await readPendingPlans();
    await vi.advanceTimersByTimeAsync(11_000);
    await readPendingPlans();

    expect(pendingPlanCalls()).toBe(2);
  });

  it('is rescanned at once after a decision, which is the one act that invalidates it', async () => {
    await readPendingPlans();
    await api.decidePlan(SESSION, true, 'plan-hash', token);
    await readPendingPlans();

    // A decided plan must not sit in the inbox for the rest of the interval: the reader just acted
    // on it and is looking straight at the list.
    expect(pendingPlanCalls()).toBe(2);
  });
});

describe('the three behaviours a careless migration flattens', () => {
  it('does not rescan the plan inbox when the window regains focus', async () => {
    // The default `refetchOnWindowFocus` is **on** upstream, and this is the route it must never
    // be on for. `client.ts` quotes the service's own docstring: the scan reaches up to 25
    // sessions and each read "is a statement on a checkpointer that serializes them against every
    // concurrent turn on the pod". A chemist alt-tabbing back to a `/review` tab left open would
    // have re-run the whole thing, for free, as often as they switched windows.
    // **Driven past the staleness window, which is what makes this a control rather than a
    // coincidence.** A focus refetch is skipped while the answer is fresh, so a version of this
    // case that alt-tabbed straight back passes with `refetchOnWindowFocus` left **on** — measured.
    // The real hazard is the tab left open on `/review` for a minute, which is exactly the state
    // this advances the clock into.
    vi.useFakeTimers();
    const observer = new QueryObserver(queryClient, pendingPlansQuery(token));
    const stop = observer.subscribe(() => undefined);
    try {
      await observer.refetch();
      expect(pendingPlanCalls()).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);

      // What the browser sends, rather than a flag this test sets: `focusManager` is what
      // react-query listens to, and telling it the window came back is the whole event.
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(pendingPlanCalls()).toBe(1);
    } finally {
      stop();
      focusManager.setFocused(undefined);
    }
  });

  it('folds a list route’s 404 into an empty list and says so in the log', async () => {
    // `orEmpty`'s degradation is deliberate — an older service yields a smaller app rather than a
    // banner — and the log line is the half that makes "the sidebar is empty" and "this
    // deployment's service predates the listing route" two observations instead of one. It stays
    // in `client.ts` because it belongs to the transport, and a `queryFn` is not where a
    // deployment fault gets recorded.
    restore?.();
    const stub = stubFetch(() => new Response('{"detail":"no such session"}', { status: 404 }));
    restore = stub.restore;
    const warn = vi.spyOn(logger, 'warn');

    await expect(api.listProfiles(token)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith('api.list_route_missing', { route: '/profiles' });
    warn.mockRestore();
  });

  it('lets the plan inbox’s own failure through, because an empty inbox is a different claim', async () => {
    // The opposite policy to the one above, on purpose: `listApprovals` folded its 404 into `[]`
    // and the screen said "nothing is waiting on you" for a release. "We could not ask" and
    // "nothing is waiting" are opposite things to tell somebody whose work is blocked, so a
    // `queryFn` that swallowed this would take the distinction away one layer up from where it
    // was won.
    restore?.();
    const stub = stubFetch(() => new Response('{"detail":"nope"}', { status: 500 }));
    restore = stub.restore;

    await expect(queryClient.fetchQuery(pendingPlansQuery(token))).rejects.toThrow();
  });
});

describe('a content-addressed read', () => {
  it('joins concurrent readers of the same bytes into one request', async () => {
    // The answer's result block and the trace panel behind it, citing one `result_ref`.
    const [a, b] = await Promise.all([
      readToolResult('r'.repeat(16)),
      readToolResult('r'.repeat(16)),
    ]);

    expect(calls).toHaveLength(1);
    // And both callers got the answer, rather than one of them getting nothing.
    expect(a).toEqual(b);
  });

  it('does not join two different refs', async () => {
    await Promise.all([readToolResult('r'.repeat(16)), readToolResult('s'.repeat(16))]);
    expect(calls).toHaveLength(2);
  });

  it('does not go back to the service for bytes it already has', async () => {
    // The half the in-flight join could never buy, and which `client.ts` admitted in its own
    // docstring: it "holds nothing after the answer arrives", so a remount — a route change, a
    // conversation switch and back, a block scrolling out of the window and in again — refetched
    // the whole payload. `staleTime: Infinity` is correct by construction here rather than by
    // judgement: the URL changes whenever the bytes do.
    await readToolResult('r'.repeat(16));
    await readToolResult('r'.repeat(16));

    expect(calls).toHaveLength(1);
  });

  it('lets the browser keep it, where every other route may not', async () => {
    await readToolResult('r'.repeat(16));
    await api.listSessions(token);

    // `no-store` is not "bypass the cache", it is "never write to it" — which is right for a
    // session list and exactly wrong for a URL that changes whenever its bytes do.
    expect(calls[0]?.cache).toBe('default');
    expect(calls[1]?.cache).toBe('no-store');
  });
});
