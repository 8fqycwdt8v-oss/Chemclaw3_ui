/**
 * What each read *is*: its key, its fetcher and how long its answer is worth.
 *
 * One factory per read, rather than the options written inline at each `useApiQuery` call. Three
 * things follow from that and each is a property this app used to have to hold by hand:
 *
 *  - **Two components asking the same question ask it with the same key.** That is the whole of
 *    the in-flight join `client.ts` used to keep as a `Map<string, Promise>`: the answer's result
 *    block and the trace panel behind it cite one `result_ref`, and each component's own
 *    `requested` ref could only ever see inside that component.
 *  - **The staleness policy is stated next to the read it belongs to**, so `IMMUTABLE` on a
 *    content-addressed URL and `PENDING_PLANS_STALE_MS` on the most expensive route in the app are
 *    decisions a reader meets together rather than hunting for.
 *  - **A test can drive the read this app actually performs.** `tests/requestEconomy.test.ts` used
 *    to call `api.listPendingPlans` twice and assert one request, because the interval lived in
 *    `client.ts`. The economy is not the transport's any more, so the test drives these — which is
 *    the same assertion about the same behaviour, aimed at where it now lives.
 *
 * The fetchers are `client.ts`'s `api`, unchanged and deliberately so: the 401-recover-once retry
 * inside `request` is app-specific — it knows what a refresh is, and that a second attempt after a
 * failed one is a redirect loop — and react-query's own `retry` is off for that reason
 * (`queryClient.ts`). `orEmpty`'s 404-to-`[]` fold **with its log line** stays there too, as does
 * `listPendingPlans` deliberately *not* swallowing: "we could not ask" and "nothing is waiting" are
 * opposite things to tell somebody whose work is blocked, and a `queryFn` that folded the error
 * into an empty list would take that distinction away one layer up.
 */

import { api } from './client.ts';
import { IMMUTABLE, PENDING_PLANS_STALE_MS, keys } from './queryClient.ts';
import type { TokenGetter } from './client.ts';
import type { DesignStatus } from '../../shared/protocols.ts';

/** One stored tool result. Content-addressed: the URL changes whenever the bytes do. */
export const toolResultQuery = (sessionId: string, ref: string, auth: TokenGetter) => ({
  queryKey: keys.toolResult(sessionId, ref),
  queryFn: () => api.getToolResult(sessionId, ref, auth),
  ...IMMUTABLE,
});

/** One knowledge note and its neighbourhood. Content-addressed on the same terms. */
export const noteQuery = (noteId: string, auth: TokenGetter) => ({
  queryKey: keys.note(noteId),
  queryFn: () => api.getNote(noteId, auth),
  ...IMMUTABLE,
});

/** The plan inbox. See `PENDING_PLANS_STALE_MS`; `api.decidePlan` invalidates this key. */
export const pendingPlansQuery = (auth: TokenGetter) => ({
  queryKey: keys.pendingPlans,
  queryFn: () => api.listPendingPlans(auth),
  staleTime: PENDING_PLANS_STALE_MS,
});

/** The profiles this deployment offers. A property of the service, not of a conversation, so it
 *  outlives every conversation switch — which is what `Composer` used component state for. */
export const profilesQuery = (auth: TokenGetter) => ({
  queryKey: keys.profiles,
  queryFn: () => api.listProfiles(auth),
  staleTime: Infinity,
});

/** Durable runs matching a search. The search text is the key, so a stale list is never shown
 *  under a new query — which is what `JobsPanel`'s `loaded.query === submitted` derivation did. */
export const jobsQuery = (text: string, auth: TokenGetter) => ({
  queryKey: keys.jobs(text),
  queryFn: () => api.listJobs(auth, { text }),
});

/** Experiment designs under a status/project filter, keyed the same way and for the same reason. */
export const protocolsQuery = (status: DesignStatus | '', project: string, auth: TokenGetter) => ({
  queryKey: keys.protocols(status, project),
  queryFn: () =>
    api.listProtocols(auth, {
      ...(status ? { status } : {}),
      ...(project ? { project } : {}),
    }),
});

/** One design, at the head or at a named revision. */
export const protocolQuery = (designId: string, at: number | undefined, auth: TokenGetter) => ({
  queryKey: keys.protocol(designId, at),
  queryFn: () => api.getProtocol(designId, auth, at),
});
