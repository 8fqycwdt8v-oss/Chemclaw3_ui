/**
 * Every durable run the lab has done, and the one control that stops one.
 *
 * Two questions this answers that nothing else in the app could.
 *
 * **"What did we already compute for this, and why?"** — `job_records` keeps the *rationale* the
 * run was launched with, which is what makes the search worth having: a job id tells you nothing
 * six weeks later, and "we ran this to decide whether the nitration was electronically favoured"
 * tells you whether to run it again. The registry is deliberately not scoped to the caller
 * upstream, because a finished calculation is a fact about the lab rather than about a person.
 *
 * **"Can I stop it?"** — until now the only escape from a mis-launched durable job was the banner's
 * "Start a fresh session", which abandons the job rather than stopping it. Cancellation is a
 * *request*: the service answers 202 and a workflow already past its last cancellation point will
 * finish regardless, so the wording never claims the job stopped.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Search, Server } from 'lucide-react';
import { useAuth, useIsReviewer } from '../auth/AuthContext.tsx';
import { api, type DurableJobStatus, type JobRecordSummary } from '../api/client.ts';
import { useNewestRead } from '../hooks/useNewestRead.ts';
import { relativeTime } from '../lib/format.ts';
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
};

/**
 * The one durable job whose *shape* a reader has to know before reading the row.
 *
 * Every run in this list is a Temporal job, so "durable" separates none of them. What separates this
 * one is that it is a **loop**: it proposes, evaluates against a registered objective, and repeats
 * for as many rounds as its spec asked for — so it runs for hours or days where a conformer search
 * runs for minutes, and it is the only kind here that ends by opening a recommendation for human
 * review. A campaign and an xTB job rendered identically, and the difference decides whether a
 * reader waits for it or goes home.
 *
 * Keyed on `JobRecordSummary.job`, which is the launch job's own name (`JobSpec.name` upstream) —
 * `job_started.kind` is a turn-stream field and does not reach this registry.
 */
const CAMPAIGN_JOB = 'start_optimization_campaign';

/**
 * What the campaign kind is, in the words of the manifest that declares it.
 *
 * Quoted from the `bo` bundle's `connector.yaml` (`jobs[].description`) rather than written here:
 * a sentence this frontend invented about how an optimisation behaves would be indistinguishable,
 * to a reader, from one the job's authors wrote.
 */
const CAMPAIGN_DESCRIPTION =
  'A multi-round optimisation campaign: it proposes candidates, evaluates them through the named ' +
  'objective, and records its recommendation as an agent-authored note. It runs for as ' +
  'many rounds as its spec asked for, so expect hours rather than the minutes a single calculation ' +
  'takes.';

function JobSheet({
  jobId,
  jobName,
  open,
  onOpenChange,
}: {
  jobId: string;
  /** `JobRecordSummary.job` — the launch job's own name. Empty when the row it was opened from is
   *  no longer in the list, which costs the kind badge and nothing else. */
  jobName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const { auth } = useAuth();
  const isReviewer = useIsReviewer();
  const [status, setStatus] = useState<DurableJobStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Tracked separately from `notice`, which a *successful* cancellation also writes. Without it
  // the spinner's `!status` guard stayed true for the life of the sheet, so a failed read showed
  // an error string with a spinner turning under it — permanently, and with no way to retry.
  const [failed, setFailed] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const claim = useNewestRead();
  const load = useCallback(
    (id: string) => {
      // Claimed before the request, so a read this one supersedes cannot land afterwards. It is
      // not only the displayed state that would be another job's: Cancel is offered on
      // `status.status === 'running'` and posts to `jobId`, so a stale status decides whether a
      // state-changing control appears for a job it does not describe. The same-id case is real
      // here too — `cancel` re-reads the job it just asked to stop. See `useNewestRead`.
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
      load(jobId);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'The cancellation was not accepted.');
    }
  };

  const running = status?.status === 'running';

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

export function JobsPanel(): React.JSX.Element {
  const { auth, ready } = useAuth();
  // `/jobs/:jobId` opens this panel with that run's sheet already up, so a run can be *sent* to
  // somebody rather than only clicked to. The parameter is read here rather than passed in, for
  // the reason `ProtocolDocument` gives about its own design id: the URL is the one thing that
  // says what is open, so a shared link and a reload land in the same place.
  const { jobId: deepLinked } = useParams();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  // The result carries the query it answers, so "loading" is derived rather than set: clearing
  // the list on the way into the effect is a second render and a lint error, and this way a
  // stale list is never shown under a new search either.
  const [loaded, setLoaded] = useState<{ query: string; list: JobRecordSummary[] } | null>(null);
  const [openId, setOpenId] = useState<string | null>(deepLinked ?? null);
  const jobs = loaded?.query === submitted ? loaded.list : null;

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void api
      .listJobs(auth, { text: submitted })
      .then((list) => !cancelled && setLoaded({ query: submitted, list }))
      .catch(() => !cancelled && setLoaded({ query: submitted, list: [] }));
    return () => {
      cancelled = true;
    };
  }, [auth, ready, submitted]);

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

        {!jobs && <Loading>Reading the registry…</Loading>}

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
                  onClick={() => setOpenId(job.job_id)}
                  className="w-full rounded-lg border border-border-subtle bg-surface-raised p-3 text-left transition-colors hover:bg-surface-sunken focus-ring"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{job.job}</span>
                    <Badge tone="neutral">{job.connector}</Badge>
                    {/* A badge and nothing more in the list: the sentence explaining what a
                        campaign is belongs in the sheet, where it is read once rather than
                        repeated down every row of a search result. */}
                    {job.job === CAMPAIGN_JOB && <Badge tone="brand">campaign</Badge>}
                    {job.completed_at && (
                      <span className="text-2xs text-ink-subtle">
                        finished {relativeTime(new Date(job.completed_at).getTime())}
                      </span>
                    )}
                  </div>
                  {/* The rationale before the id: it is the only part a reader can act on. */}
                  {job.rationale && <p className="mt-1 text-sm">{job.rationale}</p>}
                  {job.summary && <p className="mt-1 text-xs text-ink-muted">{job.summary}</p>}
                  <p className="mt-1 font-mono text-2xs break-all text-ink-subtle">{job.job_id}</p>
                </button>
              </li>
            ))}
          </ul>
        )}

        {openId !== null && (
          <JobSheet
            jobId={openId}
            jobName={jobs?.find((job) => job.job_id === openId)?.job ?? ''}
            open
            onOpenChange={(next) => {
              if (next) return;
              setOpenId(null);
              // Closing a sheet the URL opened has to move the URL too, or Back is the only way
              // out of a route that keeps reopening it.
              if (deepLinked) void navigate('/jobs', { replace: true });
            }}
          />
        )}
      </div>
    </div>
  );
}
