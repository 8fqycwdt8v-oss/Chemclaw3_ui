/**
 * The one query client, its defaults, and the keys. Separate from `queries.ts` because `client.ts`
 * invalidates keys and cannot import a module that imports `api` (see `docs/dependencies.md`).
 *
 * There is no `QueryClientProvider`: `useQuery(options, queryClient)` takes the client explicitly
 * and the app has one root; `resetQueryCache()` is the test seam.
 *
 * Defaults that differ from upstream:
 *
 * - `retry: false` — the only retry is `request`'s 401-recover-once; retries would multiply load on
 *   expensive routes.
 * - `refetchOnWindowFocus: false` — in particular `/plans/pending` scans many sessions; reads that
 *   want focus refetching ask for it (`tests/requestEconomy.test.ts`).
 * - `gcTime` is stated (`QUERY_GC_MS`).
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

/** How long an unobserved answer stays cached. Exported so tests can advance past the timer. */
export const QUERY_GC_MS = 5 * 60_000;

/**
 * Deliver query results on a microtask (upstream's documented `setScheduler` seam) rather than
 * `setTimeout(0)`, so a cached read renders without an extra frame and tests can flush with
 * microtasks.
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
 * Subscribe the client to focus and online events — normally done by `QueryClientProvider`, which
 * this app does not use. Without it `refetchOnWindowFocus`/`refetchOnReconnect` are inert (the
 * health probe relies on them). Never unmounted.
 */
queryClient.mount();

/** Test seam: clear the module-wide cache between tests. */
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
 * Every query key, in one place: a key is a read's identity, so a shared key makes two components
 * one request. Here rather than beside the option factories because `client.ts` needs
 * `keys.pendingPlans`.
 */
export const keys = {
  /** Content-addressed: the URL changes whenever the bytes do, so the key is the whole identity. */
  toolResult: (sessionId: string, ref: string) => ['tool-result', sessionId, ref] as const,
  note: (noteId: string) => ['note', noteId] as const,
  pendingPlans: ['plans', 'pending'] as const,
  /**
   * Held-open questions; `nonce` and `pushes` are in the key so a push-back frame triggers a
   * refetch.
   */
  pendingRequests: (nonce: number, pushes: number) => ['pending-requests', nonce, pushes] as const,
  sessions: ['sessions'] as const,
  /**
   * Sessions others own that this person was let into; separate from `sessions` (an infinite query
   * of owned pages).
   */
  sharedSessions: ['shared-sessions'] as const,
  /** Who is in one session: its owner and the members that owner admitted. */
  members: (sessionId: string) => ['members', sessionId] as const,
  jobs: (text: string) => ['jobs', text] as const,
  /** One durable run's status — what an artefact linking to a job reads. */
  job: (jobId: string, sessionId: string) => ['job', jobId, sessionId] as const,
  protocols: (status: string, project: string) => ['protocols', status, project] as const,
  protocol: (designId: string, at: number | undefined) =>
    ['protocol', designId, at ?? 'head'] as const,
  profiles: ['profiles'] as const,
  /** What is waiting on this person to decide about the agent's own behaviour. */
  proposals: ['proposals', 'open'] as const,
  /** The skills acting on this chemist's own turns, and on everybody's. Two keys, two tiers. */
  mySkills: ['skills', 'mine'] as const,
  orgSkills: ['skills', 'org'] as const,
  orgSkillVersions: (name: string) => ['skills', 'org', name, 'versions'] as const,
  /**
   * One skill's body, nested under its tier's key so a write to the tier invalidates list, bodies
   * and histories together.
   */
  skillBody: (tier: 'mine' | 'org', name: string) => ['skills', tier, name, 'body'] as const,
  health: ['health'] as const,
  /**
   * One session's artefacts; an `exhibit` frame invalidates this key, a revision write its prefix.
   */
  exhibits: (sessionId: string) => ['exhibits', sessionId] as const,
  /**
   * One artefact at one revision, under the list prefix. `0` is the head, a separate entry from the
   * number it resolves to.
   */
  exhibit: (sessionId: string, exhibitId: string, revision: number) =>
    ['exhibits', sessionId, exhibitId, revision] as const,
  exhibitRevisions: (sessionId: string, exhibitId: string) =>
    ['exhibits', sessionId, exhibitId, 'revisions'] as const,
  exhibitDiff: (sessionId: string, exhibitId: string, from: number, to: number) =>
    ['exhibits', sessionId, exhibitId, 'diff', from, to] as const,
  /** Every artefact of the caller's, across sessions — "My artefacts". */
  myExhibits: ['my-exhibits'] as const,
  /** A calc by-product's text, outside the `exhibits` prefix (the calc store is shared). */
  calcArtifact: (ref: string) => ['calc-artifact', ref] as const,
} as const;

/** Content-addressed reads never go stale. */
export const IMMUTABLE = { staleTime: Infinity } as const;

/**
 * Minimum interval between plan-inbox scans: `GET /plans/pending` scans up to 25 sessions on the
 * backend. A plan decision invalidates the key directly.
 */
export const PENDING_PLANS_STALE_MS = 10_000;
