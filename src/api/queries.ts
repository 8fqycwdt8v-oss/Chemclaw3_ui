/**
 * What each read is: its key, fetcher and staleness, one factory per read so the same question
 * always uses the same key, staleness sits beside the read, and tests drive the real read. Fetchers
 * are `client.ts`'s `api` (with its 401-recover-once, `orEmpty` folding and `listPendingPlans`
 * letting failures through).
 */

import { api } from './client.ts';
import { IMMUTABLE, PENDING_PLANS_STALE_MS, keys } from './queryClient.ts';
import type { JobPage, TokenGetter } from './client.ts';
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

/** Conversations others let this person into; read by the sidebar and the plan inbox. */
export const sharedSessionsQuery = (auth: TokenGetter) => ({
  queryKey: keys.sharedSessions,
  queryFn: () => api.listSharedSessions(auth),
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

/**
 * Durable runs matching a search, paged by `X-Next-Cursor` (the search is capped by
 * `job_record_search_limit`). The search text is the key.
 */
export const jobsQuery = (text: string, auth: TokenGetter) => ({
  queryKey: keys.jobs(text),
  queryFn: ({ pageParam }: { pageParam: string }) =>
    api.pageJobs(auth, { text, ...(pageParam ? { after: pageParam } : {}) }),
  initialPageParam: '',
  getNextPageParam: (page: JobPage) => page.next || undefined,
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

/**
 * One session's artefacts. Refetches on window focus (asked for by name), since a colleague's edit
 * made while this tab was hidden may have missed the best-effort push.
 */
export const exhibitsQuery = (sessionId: string, auth: TokenGetter) => ({
  queryKey: keys.exhibits(sessionId),
  queryFn: () => api.listExhibits(sessionId, auth),
  refetchOnWindowFocus: true,
});

/**
 * One artefact at one revision: numbered revisions are immutable; the head (`0`) follows list
 * invalidation.
 */
export const exhibitQuery = (
  sessionId: string,
  exhibitId: string,
  revision: number,
  auth: TokenGetter,
) => ({
  queryKey: keys.exhibit(sessionId, exhibitId, revision),
  queryFn: () => api.getExhibit(sessionId, exhibitId, auth, revision),
  ...(revision > 0 ? IMMUTABLE : {}),
});

/** One artefact's revision log, for the picker. */
export const exhibitRevisionsQuery = (sessionId: string, exhibitId: string, auth: TokenGetter) => ({
  queryKey: keys.exhibitRevisions(sessionId, exhibitId),
  queryFn: () => api.listExhibitRevisions(sessionId, exhibitId, auth),
});

/** A comparison between two numbered revisions — both immutable, so the answer is too. */
export const exhibitDiffQuery = (
  sessionId: string,
  exhibitId: string,
  from: number,
  to: number,
  auth: TokenGetter,
) => ({
  queryKey: keys.exhibitDiff(sessionId, exhibitId, from, to),
  queryFn: () => api.getExhibitDiff(sessionId, exhibitId, from, to, auth),
  ...IMMUTABLE,
});

/** Every artefact of the caller's, across sessions. */
export const myExhibitsQuery = (auth: TokenGetter) => ({
  queryKey: keys.myExhibits,
  queryFn: () => api.listMyExhibits(auth),
});

/**
 * A calc by-product as text; immutable (a calc key names its inputs; eviction gives a 404, never
 * different bytes).
 */
export const calcArtifactTextQuery = (ref: string, auth: TokenGetter) => ({
  queryKey: keys.calcArtifact(ref),
  queryFn: async () => (await api.getCalcArtifact(ref, auth)).blob.text(),
  ...IMMUTABLE,
});
