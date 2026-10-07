/**
 * Every durable run the lab has done, and the control that stops one. The registry is searchable by
 * the recorded rationale and not scoped to the caller (a finished calculation is a lab fact).
 * Cancellation is a request (202); a workflow past its last cancellation point finishes anyway, so
 * the wording never claims it stopped.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Search, Server } from 'lucide-react';
import { useAuth, useIsReviewer } from '../auth/AuthContext.tsx';
import { api, type DurableJobStatus, type JobRecordSummary } from '../api/client.ts';
import { useNewestRead } from '../hooks/useNewestRead.ts';
import { queryClient, useApiInfiniteQuery } from '../api/queryClient.ts';
import { jobsQuery } from '../api/queries.ts';
import { relativeTime } from '../lib/format.ts';
import { isTerminalJobStatus } from '../state/jobReconcile.ts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { ConfirmDialog } from '@/components/chem/ConfirmDialog';
import { EmptyState, Loading } from '@/components/chem/Feedback';

const STATUS_TONE: Record<string, 'ok' | 'danger' | 'warn' | 'brand'> = {
  completed: 'ok',
  failed: 'danger',
  cancelled: 'warn',
  running: 'brand',
  // Open and not yet started: waiting for a slot, or on a queue nothing polls. The reason arrives
  // as `summary`.
  queued: 'brand',
};

/**
 * The optimisation campaign: a loop that runs for hours or days and ends by opening a
 * recommendation for review, so it gets a badge. Keyed on `JobRecordSummary.job` (the launch job's
 * name).
 */
const CAMPAIGN_JOB = 'start_optimization_campaign';

/** The campaign description, quoted from the `bo` bundle's `connector.yaml`. */
const CAMPAIGN_DESCRIPTION =
  'A multi-round optimisation campaign: it proposes candidates, evaluates them through the named ' +
  'objective, and records its recommendation as an agent-authored note. It runs for as ' +
  'many rounds as its spec asked for, so expect hours rather than the minutes a single calculation ' +
  'takes.';

/**
 * Backoff for re-reading a run just asked to cancel (~30 s in all): the first read often lands
 * before Temporal records the cancellation. Bounded; after it, "Try again". Exported for the test.
 */
export const CANCEL_REREAD_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000, 8000, 8000, 8000];

/** A wait that unmounting cuts short: the cleanup wakes every pending wait at once. */
const sleep = (ms: number, wakers: Set<() => void>): Promise<void> =>
  new Promise((resolve) => {
    const wake = (): void => {
      clearTimeout(timer);
      wakers.delete(wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    wakers.add(wake);
  });

/** The registry list under every search text — a cancelled run's row changes in all of them. */
const invalidateJobList = (): Promise<void> =>
  queryClient.invalidateQueries({ queryKey: ['jobs'] });

function JobSheet({
  jobId,
  jobName,
  open,
  onOpenChange,
}: {
  jobId: string;
  /** The launch job's name; empty if its row left the list (only the kind badge is lost). */
  jobName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const { auth } = useAuth();
  const isReviewer = useIsReviewer();
  const [status, setStatus] = useState<DurableJobStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Separate from `notice`, so a failed read shows an error without a spinner.
  const [failed, setFailed] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const claim = useNewestRead();
  const load = useCallback(
    (id: string) => {
      // Claimed before the request so a superseded read cannot land: a stale status would decide
      // whether Cancel is offered for the wrong job. See `useNewestRead`.
      const isNewest = claim();
      setStatus(null);
      setFailed(false);
      api
        .getJob(id, auth)
        .then((next) => isNewest() && setStatus(next))
        .catch((err: unknown) => {
          if (!isNewest()) return;
          setFailed(true);
          setNotice(err instanceof Error ? err.message : 'Could not read that job.');
        });
    },
    [auth, claim],
  );

  // Set in the effect body (StrictMode-safe). On unmount, sleeping follow-ups are woken and stop at
  // once, so their list invalidation happens now, not seconds later.
  const mounted = useRef(true);
  const wakers = useRef(new Set<() => void>());
  useEffect(() => {
    mounted.current = true;
    const pending = wakers.current;
    return () => {
      mounted.current = false;
      for (const wake of [...pending]) wake();
    };
  }, []);

  /**
   * Re-read a run asked to cancel until it ends or the backoff runs out, keeping the shown status
   * between reads. Guarded by the newest-read check; intermediate failures are not reported.
   */
  const follow = async (id: string): Promise<void> => {
    const isNewest = claim();
    try {
      for (const delay of CANCEL_REREAD_DELAYS_MS) {
        await sleep(delay, wakers.current);
        if (!isNewest() || !mounted.current) return;
        let next: DurableJobStatus;
        try {
          next = await api.getJob(id, auth);
        } catch {
          continue;
        }
        if (!isNewest()) return;
        setStatus(next);
        setFailed(false);
        if (isTerminalJobStatus(next.status)) return;
      }
    } finally {
      // Always invalidate the shared job list on the way out, since its row carries the state too.
      void invalidateJobList();
    }
  };

  if (open && loadedFor !== jobId) {
    setLoadedFor(jobId);
    setNotice(null);
    load(jobId);
  }

  const cancel = async (): Promise<void> => {
    try {
      await api.cancelJob(jobId, auth);
      // Never "cancelled": the service accepts the request, and a workflow past its last
      // cancellation point finishes anyway. Saying it stopped would be a claim we cannot back.
      setNotice(
        'Cancellation requested. A run already past its last checkpoint will still finish.',
      );
      void follow(jobId);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'The cancellation was not accepted.');
    }
  };

  // Cancellation is offered on an open run, and a run waiting to start is open: it is the one a
  // chemist is likeliest to want to call off, because nothing has been spent on it yet.
  const running = status?.status === 'running' || status?.status === 'queued';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" title={`Job ${jobId}`} className="w-[min(40rem,95vw)]">
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
          <p className="font-mono text-xs break-all">{jobId}</p>

          {jobName === CAMPAIGN_JOB && (
            <div className="flex flex-col gap-1.5">
              <Badge tone="brand">optimisation campaign</Badge>
              <p className="text-xs text-ink-muted">{CAMPAIGN_DESCRIPTION}</p>
            </div>
          )}

          {notice && (
            <p
              role="status"
              className="rounded-lg border border-border-subtle bg-surface-sunken px-3 py-2 text-xs"
            >
              {notice}
            </p>
          )}

          {failed && (
            <div>
              <Button variant="outline" size="sm" onClick={() => load(jobId)}>
                Try again
              </Button>
            </div>
          )}

          {!status && !failed && <Loading>Reading the job…</Loading>}

          {status && (
            <>
              <Badge tone={STATUS_TONE[status.status] ?? 'neutral'}>{status.status}</Badge>

              {status.rationale && (
                <div>
                  <h3 className="mb-1 text-2xs font-medium tracking-wide text-ink-subtle uppercase">
                    Why it was run
                  </h3>
                  <p className="text-sm">{status.rationale}</p>
                </div>
              )}

              {status.summary && <p className="text-sm text-ink-muted">{status.summary}</p>}

              {status.calc_refs?.length ? (
                <div>
                  <h3 className="mb-1 text-2xs font-medium tracking-wide text-ink-subtle uppercase">
                    Calculations it rested on
                  </h3>
                  {/* The keys themselves, because they are what a note cites: a count would say
                      how many there were and leave a reader with nothing to quote. */}
                  <p className="font-mono text-2xs break-all text-ink-muted">
                    {status.calc_refs.join(' · ')}
                  </p>
                </div>
              ) : null}

              <div>
                <h3 className="mb-1 text-2xs font-medium tracking-wide text-ink-subtle uppercase">
                  Result
                </h3>
                <pre
                  tabIndex={0}
                  role="region"
                  aria-label="The job's result"
                  className="max-h-96 overflow-auto rounded-lg border border-border-subtle bg-surface-sunken p-3 font-mono text-2xs whitespace-pre-wrap focus-ring"
                >
                  {JSON.stringify(status.result, null, 2)}
                </pre>
              </div>

              {running && isReviewer && (
                <ConfirmDialog
                  trigger={
                    <Button variant="outline-destructive" size="sm">
                      Request cancellation
                    </Button>
                  }
                  title="Stop this run?"
                  description="The service is asked to cancel it. Work already committed on the cluster may still complete, and anything it has spent is not recovered."
                  confirmLabel="Request cancellation"
                  variant="destructive"
                  // `cancel` handles its own failures and cannot reject; `void` says so where
                  // the dialog expects a void handler.
                  onConfirm={() => void cancel()}
                />
              )}
              {running && !isReviewer && (
                <p className="text-xs text-ink-muted">Cancelling a run needs a reviewer role.</p>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * One row per run across overlapping pages: re-recorded runs move to the top and can reappear on
 * the next page. The first sighting wins.
 */
function uniqueRuns(jobs: JobRecordSummary[]): JobRecordSummary[] {
  const seen = new Set<string>();
  return jobs.filter((job) => {
    if (seen.has(job.job_id)) return false;
    seen.add(job.job_id);
    return true;
  });
}

export function JobsPanel(): React.JSX.Element {
  const { auth, ready } = useAuth();
  // `/jobs/:jobId` opens that run's sheet. The URL is the only state for what is open (rows
  // navigate), so links, Back and Forward all agree.
  const { jobId: openId = null } = useParams();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  // The search text is the key, so a stale list never shows under a new search.
  const {
    data,
    isError,
    isFetchNextPageError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  } = useApiInfiniteQuery({
    ...jobsQuery(submitted, auth),
    enabled: ready,
  });
  // Three states: `null` loading, `[]` nothing matched, and a failed first read (shown as a
  // failure; the benign 404 is already an empty page).
  const failed = isError && !data;
  const jobs = data ? uniqueRuns(data.pages.flatMap((page) => page.jobs)) : null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <div>
          <h2 className="mb-1 text-lg font-semibold tracking-tight">Durable runs</h2>
          <p className="text-sm text-ink-muted">
            Every calculation, campaign and report this service has run — with the reason each was
            launched, which is what makes an old one findable.
          </p>
        </div>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(query.trim());
          }}
        >
          <label htmlFor="job-search" className="sr-only-live">
            Search runs
          </label>
          <input
            id="job-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search what a run was for — “nitration selectivity”, “solvent screen”"
            className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm outline-none focus-ring"
          />
          <Button type="submit" size="sm">
            <Search aria-hidden className="size-3.5" />
            Search
          </Button>
        </form>

        {/* An explicit retry: the client never retries on its own, and resubmitting the same text would not change the key. */}
        {failed && (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className="text-sm text-danger-ink">
              Could not search the registry, so this says nothing about which runs exist — try
              again.
            </p>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              Try again
            </Button>
          </div>
        )}

        {!jobs && !failed && <Loading>Reading the registry…</Loading>}

        {jobs?.length === 0 && (
          <EmptyState
            icon={<Server className="size-5" />}
            title={submitted ? 'No run matches that' : 'No runs recorded yet'}
          >
            {submitted
              ? 'The search covers the rationale recorded when each run was launched, not its result.'
              : 'A durable job appears here as soon as one is launched — a conformer search, an optimisation campaign, a development report.'}
          </EmptyState>
        )}

        {jobs && jobs.length > 0 && (
          <ul className="flex flex-col gap-2">
            {jobs.map((job) => (
              <li key={job.job_id}>
                <button
                  type="button"
                  // Navigating rather than setting state, so what is open is the URL and only
                  // the URL — see the note on `openId` above.
                  onClick={() => void navigate(`/jobs/${encodeURIComponent(job.job_id)}`)}
                  className="w-full rounded-lg border border-border-subtle bg-surface-raised p-3 text-left transition-colors hover:bg-surface-sunken focus-ring"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{job.job}</span>
                    <Badge tone="neutral">{job.connector}</Badge>
                    {/* A badge in the list; the explanation is in the sheet. */}
                    {job.job === CAMPAIGN_JOB && <Badge tone="brand">campaign</Badge>}
                    {/* State only when not completed, so it stands out. */}
                    {job.state && job.state !== 'completed' && (
                      <Badge tone={STATUS_TONE[job.state] ?? 'danger'}>{job.state}</Badge>
                    )}
                    {job.completed_at && (
                      <span className="text-2xs text-ink-subtle">
                        {/* "finished" is a claim about the run, not about the clock: a failed run
                            stopped at this time, and it did not finish anything. */}
                        {job.state === 'failed' ? 'failed' : 'finished'}{' '}
                        {relativeTime(new Date(job.completed_at).getTime())}
                      </span>
                    )}
                  </div>
                  {/* The step the run served, read off the listing rather than looked up — and
                      worded the way the trace's own launch row words it. */}
                  {job.plan_step && (
                    <p className="mt-1 truncate text-2xs text-ink-muted">for {job.plan_step}</p>
                  )}
                  {/* The rationale before the id: it is the only part a reader can act on. */}
                  {job.rationale && <p className="mt-1 text-sm">{job.rationale}</p>}
                  {job.summary && <p className="mt-1 text-xs text-ink-muted">{job.summary}</p>}
                  <p className="mt-1 font-mono text-2xs break-all text-ink-subtle">{job.job_id}</p>
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Only when the service said a further row exists. */}
        {hasNextPage && (
          <Button
            variant="outline"
            size="sm"
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
          >
            {isFetchingNextPage ? 'Loading…' : 'Load older runs'}
          </Button>
        )}
        {/* A failed older page is said beside the control, as in `Sidebar`. */}
        {isFetchNextPageError && !isFetchingNextPage && (
          <p role="alert" className="text-xs text-danger-ink">
            Could not load older runs — try again.
          </p>
        )}

        {openId !== null && (
          <JobSheet
            jobId={openId}
            jobName={jobs?.find((job) => job.job_id === openId)?.job ?? ''}
            open
            onOpenChange={(next) => {
              if (next) return;
              // Closing is a navigation for the same reason opening is. `replace`, so Back from a
              // closed sheet returns to wherever the reader came from rather than reopening it.
              void navigate('/jobs', { replace: true });
            }}
          />
        )}
      </div>
    </div>
  );
}
