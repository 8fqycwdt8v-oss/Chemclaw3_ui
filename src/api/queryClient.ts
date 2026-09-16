/**
 * The one query client, its defaults, and the keys.
 *
 * Split from `queries.ts` — which holds what each read *is* — because `client.ts` invalidates the
 * plan-inbox key from inside `decidePlan` and cannot import a module that imports `api`.
 *
 * ## The policy this reverses
 *
 * This repository declined a data-fetching library, and every read was `useEffect` plus
 * `let cancelled = false` plus a `useState<view | null>` plus a `useState(failed)` — the same four
 * lines, ten times, each a place to get the cancellation wrong. Two of them had already been got
 * wrong in ways that cost a rendered answer, and both are recorded in the files they happened in:
 * `ResultBlock` needed a `requested` ref because putting `state.status` in the dependency list made
 * the effect cancel the fetch its own previous run had started, and a *second* ref re-armed on
 * every mount because React 19's StrictMode double-invoke left a plain `mounted` flag `false` for
 * the life of the component — a 200 that rendered nothing, in development, for ever.
 *
 * Those are not mistakes somebody made. They are what the shape costs, and the owner approved
 * taking the dependency that removes it. See `docs/dependencies.md`.
 *
 * ## The client is a singleton, and there is no `QueryClientProvider`
 *
 * `useQuery(options, queryClient)` takes the client explicitly — supported API, not a workaround —
 * and this app has exactly one React root. A provider would be a second way to say the same thing,
 * and it would have to be threaded through every one of the 26 test files that render one of these
 * components directly. The cache is module-scoped exactly as `inFlight` and `pendingPlansCache`
 * were before it, and `resetQueryCache()` is the same test seam `resetPendingPlansCache()` was,
 * for the same reason: one test would otherwise answer the next one's question.
 *
 * ## Three defaults this app does not take from upstream
 *
 *  - **`retry: false`.** react-query retries three times with backoff. Nothing here retried before
 *    except the 401-recover-once inside `request`, which stays where it is because it is
 *    app-specific — it knows what a refresh is and that a second attempt after a failed one is a
 *    redirect loop. Leaving the default on would triple the load on the most expensive route in
 *    the app and change every failure's timing.
 *  - **`refetchOnWindowFocus: false`.** Nothing refetched on focus before, so this is the honest
 *    default rather than a special case — and it is *load-bearing* for `/plans/pending`, whose own
 *    route docstring is quoted in `client.ts`: the service scans up to 25 sessions, and each read
 *    "is a statement on a checkpointer that serializes them against every concurrent turn on the
 *    pod". A chemist alt-tabbing back to a `/review` tab must not re-run that.
 *    `tests/requestEconomy.test.ts` drives it. The one read that *wants* focus refetching — the
 *    health probe — asks for it by name, which is how it should have to be spelled.
 *  - **`gcTime`.** Stated rather than inherited — see `QUERY_GC_MS`.
 */

import {
  notifyManager,
  QueryClient,
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type UseInfiniteQueryOptions,
  type UseInfiniteQueryResult,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query';

/**
 * How long an answer nobody is observing stays in the cache before it is dropped.
 *
 * Stated rather than inherited, because an unbounded cache of tool-result payloads in a long-lived
 * tab is the failure mode a content-addressed `staleTime: Infinity` invites. It is also a *timer*,
 * armed when the last observer unmounts — exported so `tests/rateLimit.test.ts` can advance past it
 * rather than transcribe it, since that case asserts a component leaves no timer behind.
 */
export const QUERY_GC_MS = 5 * 60_000;

/**
 * Deliver a query's result on a microtask, not on a `setTimeout(0)`.
 *
 * react-query's `notifyManager` batches notifications with `setTimeout(callback, 0)` by default.
 * That is a deliberate upstream choice and it is the wrong one *here*, because of what this app is
 * migrating from: every one of these reads used to be `promise.then(setState)`, which lands in the
 * promise's own microtask. Leaving the default on would add a macrotask hop to every read in the
 * app — one more frame of "Reading…" on a cache hit, on a result block, on a note panel — as a
 * side effect of a refactor that is supposed to change nothing a chemist can see.
 *
 * It is also what makes the change *checkable*. Three existing tests drive a read to completion by
 * flushing microtasks with no time passing (`tests/staleSheetResponse.test.tsx` says so in its own
 * helper: "a timer-based wait would let the deferred responses this test is holding resolve out
 * from under it"). Under the default scheduler those tests cannot observe a result at all, and the
 * only way to keep them would be to teach each one to advance a clock — which would mean the suite
 * agreeing with the implementation rather than asserting on it.
 *
 * `setScheduler` is upstream's own documented seam for this, and `queueMicrotask` is the value its
 * documentation names.
 */
notifyManager.setScheduler(queueMicrotask);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      gcTime: QUERY_GC_MS,
    },
  },
});
/**
 * Subscribe the client to the browser's focus and online events.
 *
 * `QueryClientProvider` does this on mount, and there is none here — so without this line
 * `refetchOnWindowFocus` and `refetchOnReconnect` are **inert everywhere**, whatever any query
 * asks for. That is not a theoretical gap: `TopBar`'s health probe replaced two hand-written
 * listeners (`visibilitychange` and `online`) with those two options, and every probe taken during
 * an outage fails — so the dot would have read "unreachable" for up to 30 s after the Wi-Fi came
 * back, which is the moment a chemist is most likely to be looking at it.
 *
 * It was found by driving the *other* direction: a case asserting that the plan inbox is not
 * rescanned on focus passed with `refetchOnWindowFocus` deliberately turned **on**, because
 * nothing was listening for focus at all. A control that cannot fail is the one thing worse than
 * no control, and this is the line that makes both of them mean something.
 *
 * Never unmounted: this client lives as long as the page does, which is the same claim the
 * singleton itself makes.
 */
queryClient.mount();

/**
 * Test seam: the cache is module-wide, so one test would otherwise answer the next one's question.
 *
 * The same shape, and the same reason, as `resetClientEventBudget` in `server/clientEvents.ts` —
 * and the direct replacement for `resetPendingPlansCache`, which did this for one entry.
 */
export function resetQueryCache(): void {
  queryClient.clear();
}

/** `useQuery`, against this app's one client. */
export function useApiQuery<TQueryFnData, TError = Error, TData = TQueryFnData>(
  options: UseQueryOptions<TQueryFnData, TError, TData>,
): UseQueryResult<TData, TError> {
  return useQuery(options, queryClient);
}

/** `useInfiniteQuery`, against this app's one client. */
export function useApiInfiniteQuery<TQueryFnData, TError = Error, TPageParam = unknown>(
  options: UseInfiniteQueryOptions<
    TQueryFnData,
    TError,
    InfiniteData<TQueryFnData, TPageParam>,
    readonly unknown[],
    TPageParam
  >,
): UseInfiniteQueryResult<InfiniteData<TQueryFnData, TPageParam>, TError> {
  return useInfiniteQuery(options, queryClient);
}

/**
 * Every query key this app uses, in one place.
 *
 * A key is a read's *identity*, and identity is what the thing this replaces got wrong: two
 * components citing one `result_ref` were two round trips to the blob store, because each
 * component's own `requested` ref could only see inside that component. A shared key is what makes
 * them one read, so the keys belong together where a reader can see that two of them are not
 * accidentally the same and that none of them is accidentally different.
 *
 * They live here rather than beside the option factories because `client.ts` reaches for
 * `keys.pendingPlans` and may not import `queries.ts`.
 */
export const keys = {
  /** Content-addressed: the URL changes whenever the bytes do, so the key is the whole identity. */
  toolResult: (sessionId: string, ref: string) => ['tool-result', sessionId, ref] as const,
  note: (noteId: string) => ['note', noteId] as const,
  pendingPlans: ['plans', 'pending'] as const,
  /**
   * The held-open questions, and the two things that re-ask for them.
   *
   * `nonce` and `pushes` are *in the key* rather than in a dependency array — a frame off the
   * push-back stream moves `awaitingRevision`, which is the whole reason an inbox left open on
   * screen notices a new question without polling. It lived inline at its one call site while this
   * docstring said every key in the app is here, which is the one claim a key list exists to make.
   */
  pendingRequests: (nonce: number, pushes: number) => ['pending-requests', nonce, pushes] as const,
  sessions: ['sessions'] as const,
  jobs: (text: string) => ['jobs', text] as const,
  protocols: (status: string, project: string) => ['protocols', status, project] as const,
  protocol: (designId: string, at: number | undefined) =>
    ['protocol', designId, at ?? 'head'] as const,
  profiles: ['profiles'] as const,
  health: ['health'] as const,
} as const;

/**
 * What a content-addressed read is worth caching for: for ever.
 *
 * Not a tuning choice — it is what content-addressing *means*. `client.ts` already recorded the gap
 * this closes: "a remount (a route change, a conversation switch and back, a block scrolling out of
 * the window and in again) refetched the whole payload every time", because `send` sets `no-store`
 * by default and the in-flight join held nothing once the answer arrived. A key whose bytes cannot
 * change under it is the one case where `Infinity` is correct by construction rather than by
 * judgement.
 */
export const IMMUTABLE = { staleTime: Infinity } as const;

/**
 * The shortest interval between two scans of the plan inbox.
 *
 * `GET /plans/pending` is the most expensive thing one navigation in this app can trigger: the
 * service scans up to `service_max_plan_scans` (25) sessions, and its own route docstring says each
 * read "is a statement on a checkpointer that serializes them against every concurrent turn on the
 * pod". `ReviewQueue` mounts it on every visit to `/review`, so a chemist bouncing between the
 * inbox and a conversation paid for the whole scan each time.
 *
 * Ten seconds, which is short enough that nobody navigates through it deliberately and long enough
 * to collapse a bounce. It is a `staleTime` rather than a cache with an expiry policy for the same
 * reason it was a minimum interval before: the one action that can invalidate this answer is a plan
 * decision, and that decision invalidates the key rather than waiting the interval out.
 */
export const PENDING_PLANS_STALE_MS = 10_000;
