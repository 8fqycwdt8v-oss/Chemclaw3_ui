/**
 * The durable-run surface: what has run, how it ended, and stopping one.
 *
 * There was no job surface in this UI at all. Status and result were reachable only as an agent
 * tool inside a turn, so a chemist could not list what was running, and a result belonging to a
 * session that had since been evicted was unreachable even though `job_records` still held it.
 *
 * Two backend properties are surfaced rather than hidden, because papering over either would make
 * the panel lie:
 *
 *   - `GET /jobs` is **not owner-scoped**. That is the deployment's stated position, not an
 *     oversight — the agent's own tool over the same table is unscoped for cross-project learning.
 *     So the "Mine" filter is a client-side filter on `requested_by`, and the unfiltered view is
 *     labelled as everyone's rather than implied to be the caller's.
 *   - Cancellation is **cooperative and privileged**. 202 means the request was delivered, not
 *     that the run stopped; 403 is the expected answer for most callers, because a job id hashes
 *     its inputs and excludes its requester, so two chemists asking for the same campaign join one
 *     run and neither is more entitled to end it for the other.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, TERMINAL_JOB_STATUSES, type JobRecord } from '../api/client.ts';
import { ApiError } from '../api/errors.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { cn } from '../lib/cn.ts';

type Filter = 'mine' | 'all';

function statusTone(status: string): string {
  if (status === 'completed') return 'text-ok';
  if (TERMINAL_JOB_STATUSES.has(status)) return 'text-danger';
  return 'text-ink-muted';
}

export function JobsPanel(): React.JSX.Element {
  const { auth } = useAuth();
  const [jobs, setJobs] = useState<JobRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Through a ref-free stable callback: `useAuth()` returns a fresh object each render, so listing
  // it as a dependency would refetch the whole list on every state change.
  const token = useCallback(() => auth.getAccessToken(), [auth]);

  // Reloads are requested by bumping a token rather than by calling a fetch function, so the
  // fetch can live inside the effect. That is what lets it carry a `live` flag: a response
  // arriving after the panel unmounts (or after a second reload overtakes the first) is dropped
  // instead of writing into a component that is gone.
  const [reloadToken, setReloadToken] = useState(0);
  const reload = (): void => setReloadToken((n) => n + 1);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const next = await api.listJobs(token);
        if (!live) return;
        setJobs(next);
        setError(null);
      } catch (err) {
        if (!live) return;
        setError(err instanceof Error ? err.message : 'Could not load jobs.');
        setJobs([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [token, reloadToken]);

  const cancel = async (jobId: string): Promise<void> => {
    setBusy(jobId);
    setNote(null);
    try {
      await api.cancelJob(jobId, token);
      // Deliberately not "cancelled": the backend has accepted the request and the run may take a
      // while to notice. Claiming it stopped would be the same class of lie as a job that says
      // "running" forever.
      setNote(`Cancellation requested for ${jobId}. It will stop when the run notices.`);
      reload();
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'forbidden') {
        setNote(
          'Cancelling a durable job is an operator action: the run may be shared by several ' +
            'requesters, so it needs a privileged role.',
        );
      } else {
        setNote(err instanceof Error ? err.message : 'Could not cancel that job.');
      }
    } finally {
      setBusy(null);
    }
  };

  const mine = auth.account?.id;
  const shown =
    filter === 'mine' && mine ? (jobs ?? []).filter((j) => j.requested_by === mine) : (jobs ?? []);

  return (
    <section aria-labelledby="jobs-heading" className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2">
        <h2 id="jobs-heading" className="text-sm font-medium">
          Durable runs
        </h2>
        <div className="flex gap-1" role="group" aria-label="Filter jobs">
          {(['all', 'mine'] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                'rounded px-2 py-0.5 text-xs focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
                filter === f ? 'bg-accent-soft text-accent' : 'text-ink-muted hover:text-ink',
              )}
            >
              {f === 'all' ? 'Everyone’s' : 'Mine'}
            </button>
          ))}
        </div>
      </div>

      <p aria-live="polite" className="sr-only">
        {jobs === null ? 'Loading jobs' : `${shown.length} jobs`}
      </p>

      {note && (
        <p role="status" className="border-b border-border-subtle px-4 py-2 text-xs text-ink-muted">
          {note}
        </p>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-2">
        {jobs === null && <p className="text-sm text-ink-muted">Loading…</p>}
        {error && <p className="text-sm text-danger">{error}</p>}
        {jobs !== null && shown.length === 0 && !error && (
          <p className="text-sm text-ink-muted">
            {filter === 'mine' ? 'You have not started any durable runs.' : 'No durable runs yet.'}
          </p>
        )}

        <ul className="space-y-2">
          {shown.map((job) => (
            <li
              key={job.job_id}
              className="rounded-md border border-border-subtle bg-surface-raised p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {job.job}
                    <span className="ml-1.5 text-xs text-ink-muted">{job.connector}</span>
                  </p>
                  <p className="font-mono text-[0.7rem] break-all text-ink-muted">{job.job_id}</p>
                </div>
                <button
                  type="button"
                  disabled={busy === job.job_id}
                  onClick={() => void cancel(job.job_id)}
                  className="shrink-0 rounded border border-border-subtle px-2 py-0.5 text-xs disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                >
                  {busy === job.job_id ? 'Requesting…' : 'Cancel'}
                </button>
              </div>
              {job.summary && <p className="mt-1.5 text-sm break-words">{job.summary}</p>}
              {job.rationale && <p className="mt-1 text-xs text-ink-muted">{job.rationale}</p>}
              <p className="mt-1 text-xs">
                <span className={statusTone(job.completed_at ? 'completed' : 'running')}>
                  {job.completed_at ? `finished ${job.completed_at}` : 'no completion recorded'}
                </span>
                {job.requested_by && (
                  <span className="ml-1.5 text-ink-muted">· asked by {job.requested_by}</span>
                )}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
