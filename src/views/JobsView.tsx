/**
 * Durable runs, outside the conversation that started them.
 *
 * The point of the surface is that a job outlives its chat: `job_records` answers for a run whose
 * session was evicted and whose Temporal history has aged out, and it carries the *reason* the run
 * was asked for, so an old row is useful without the conversation that produced it.
 *
 * **`GET /jobs` lists finished runs only**, and the view says so rather than implying otherwise.
 * A record row is written by the workflow after the job completes, so nothing in flight is ever in
 * that list — which would make a cancel button on it decorative. Two other paths reach a *running*
 * job, and both are here: jobs this browser watched start in a conversation (the entity store
 * holds them, and `useJobFeed` closes them), and a job id typed in directly, which is how an
 * operator reaches a run somebody else launched.
 */

import { useMemo, useState } from 'react';
import { api, type DurableJobStatus, type JobRecordSummary } from '../api/client.ts';
import { ApiError } from '../api/errors.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { useEntityStore, type JobEntity } from '../chem/entities.ts';
import { JobResultCard } from '../components/JobResultCard.tsx';
import { cn } from '../lib/cn.ts';
import { Button, Callout, Page, Pill, When, type Tone } from './ui.tsx';
import { errorText, useResource } from './useResource.ts';

/**
 * The statuses `job_status` can report, split by whether the run can still be asked to stop.
 *
 * `_TERMINAL` upstream maps Temporal's enum onto five words and everything else onto `running`, so
 * this list is the closed set and an unrecognised status is treated as still-live — the safe way
 * round, because offering a cancel for a finished job is a 404 while withholding one for a running
 * job leaves it burning.
 */
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'terminated', 'timed_out']);

const STATUS_TONE: Record<string, Tone> = {
  completed: 'ok',
  running: 'accent',
  cancelled: 'warn',
  failed: 'danger',
  terminated: 'danger',
  timed_out: 'danger',
};

export function JobsView(): React.JSX.Element {
  const records = useResource<JobRecordSummary[]>((getToken) => api.listJobs(getToken), []);
  const [selected, setSelected] = useState<string | null>(null);

  // Jobs this browser saw start. `useJobFeed` stays mounted at the App level, so a completion that
  // lands while this page is open updates these rows without a refresh.
  //
  // Two selectors and a `useMemo`, not one selector that filters. Zustand v5 compares the selector
  // result by reference, so a selector returning a freshly-built array is a new snapshot on every
  // render — which is an infinite render loop, not a slow component.
  const entities = useEntityStore((s) => s.entities);
  const order = useEntityStore((s) => s.order);
  const live = useMemo(
    () =>
      order
        .map((key) => entities[key])
        .filter((e): e is JobEntity => e?.kind === 'job' && e.status === 'running'),
    [order, entities],
  );

  return (
    <Page
      title="Durable runs"
      subtitle="Every finished run this system recorded, with the reason it was started. A run still in flight is reachable by its id."
      actions={
        <Button onClick={records.reload} disabled={records.loading}>
          {records.loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      }
    >
      <JobLookup onOpen={setSelected} />

      {live.length > 0 && (
        <section className="mt-4">
          <h2 className="mb-2 text-xs font-medium tracking-wide text-ink-muted uppercase">
            Started in this browser and not yet finished
          </h2>
          <ul className="space-y-1.5">
            {live.map((job) => (
              <li key={job.key}>
                <JobRow
                  jobId={job.jobId}
                  selected={selected === job.jobId}
                  onSelect={setSelected}
                  primary={job.jobKind}
                  secondary="running"
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-4">
        <h2 className="mb-2 text-xs font-medium tracking-wide text-ink-muted uppercase">
          Finished runs
        </h2>

        {records.error !== undefined && (
          <Callout tone="danger" title="The job record could not be read.">
            {errorText(records.error)} Nothing below is a claim that no runs exist.
          </Callout>
        )}

        {records.data?.length === 0 && records.error === undefined && (
          <Callout tone="neutral">
            No finished runs recorded. A deployment with no durable store keeps none, which reads
            the same as an empty table.
          </Callout>
        )}

        <ul className="space-y-1.5">
          {(records.data ?? []).map((record) => (
            <li key={record.job_id}>
              <JobRow
                jobId={record.job_id}
                selected={selected === record.job_id}
                onSelect={setSelected}
                primary={`${record.connector} / ${record.job}`}
                secondary={record.summary}
                rationale={record.rationale}
                completedAt={record.completed_at ?? null}
                noteId={record.note_id}
              />
            </li>
          ))}
        </ul>
      </section>

      {selected && <JobDetail jobId={selected} onClose={() => setSelected(null)} />}
    </Page>
  );
}

/** Reach a run by id — the only way to a job that is still going, or to one somebody else started. */
function JobLookup({ onOpen }: { onOpen: (jobId: string) => void }): React.JSX.Element {
  const [text, setText] = useState('');
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const id = text.trim();
        if (id) onOpen(id);
      }}
    >
      <label htmlFor="job-id" className="text-sm text-ink-muted">
        Open a job by id
      </label>
      <input
        id="job-id"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="qm-compute_dft_energy-…"
        className="min-w-0 flex-1 rounded border border-border-subtle bg-surface-raised px-2 py-1 font-mono text-sm"
      />
      <Button onClick={() => text.trim() && onOpen(text.trim())} disabled={!text.trim()}>
        Open
      </Button>
    </form>
  );
}

function JobRow({
  jobId,
  primary,
  secondary,
  rationale,
  completedAt,
  noteId,
  selected,
  onSelect,
}: {
  jobId: string;
  primary: string;
  secondary?: string;
  rationale?: string;
  completedAt?: string | null;
  noteId?: string;
  selected: boolean;
  onSelect: (jobId: string) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onSelect(jobId)}
      className={cn(
        'w-full rounded-md border px-3 py-2 text-left transition-colors',
        selected
          ? 'border-accent/50 bg-accent-soft'
          : 'border-border-subtle bg-surface-raised hover:brightness-95',
      )}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium">{primary}</span>
        {completedAt !== undefined && (
          <span className="text-xs">
            <When iso={completedAt} />
          </span>
        )}
        {noteId && (
          <span className="font-mono text-xs text-ink-muted" title="Knowledge note this run published">
            {noteId}
          </span>
        )}
      </div>
      {secondary && <p className="mt-0.5 text-sm text-ink-muted">{secondary}</p>}
      {/* The reason the run was started. It is the field that makes a months-old row answerable
          without its conversation, so it is on the row and not behind a click. */}
      {rationale && <p className="mt-1 text-xs text-ink-muted italic">{rationale}</p>}
      <p className="mt-1 font-mono text-[11px] break-all text-ink-muted">{jobId}</p>
    </button>
  );
}

function JobDetail({ jobId, onClose }: { jobId: string; onClose: () => void }): React.JSX.Element {
  const status = useResource<DurableJobStatus>((getToken) => api.getJob(jobId, getToken), [jobId]);
  const state = status.data?.status ?? '';
  const live = state !== '' && !TERMINAL.has(state);

  return (
    <section className="mt-5 rounded-lg border border-border-subtle bg-surface-raised p-4">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="font-medium">Run detail</h2>
        {state && <Pill tone={STATUS_TONE[state] ?? 'neutral'}>{state}</Pill>}
        <div className="ml-auto flex items-center gap-2">
          <Button onClick={status.reload} disabled={status.loading}>
            {status.loading ? 'Reading…' : 'Re-read status'}
          </Button>
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>

      <p className="mb-3 font-mono text-xs break-all text-ink-muted">{jobId}</p>

      {status.error !== undefined && (
        <Callout tone="danger" title="This run's status could not be read.">
          {errorText(status.error)}
        </Callout>
      )}

      {status.data && (
        <div className="space-y-3">
          {status.data.rationale && (
            <div>
              <h3 className="text-xs font-medium tracking-wide text-ink-muted uppercase">
                Why it was run
              </h3>
              <p className="mt-1 text-sm">{status.data.rationale}</p>
            </div>
          )}

          {status.data.summary ? (
            <div>
              <h3 className="text-xs font-medium tracking-wide text-ink-muted uppercase">Result</h3>
              <p className="mt-1 text-sm">{status.data.summary}</p>
            </div>
          ) : (
            !TERMINAL.has(state) && (
              <p className="text-sm text-ink-muted">
                No result yet — the backend reports status alone until a run completes.
              </p>
            )
          )}

          {/* Reuse of the push-back card is deliberate: the same job result should not have two
              visual languages depending on whether a chemist was mid-conversation when it landed.
              `result` is `dict[str, Any]` by contract, so the card probes every field and renders
              the id alone for a job kind it has never seen. */}
          {status.data.result && Object.keys(status.data.result).length > 0 && (
            <div className="rounded-md border border-border-subtle bg-surface-sunken p-3">
              <JobResultCard jobId={jobId} summary={status.data.result} />
            </div>
          )}

          <CancelControl jobId={jobId} live={live} onPolled={status.reload} />
        </div>
      )}
    </section>
  );
}

/**
 * "Stop this run" — the action whose honest rendering is the hard part of this view.
 *
 * Two backend facts, and eliding either would put a false claim on screen:
 *
 *  - It is **reviewer-gated**, 403 for everyone else, and not because ownership was overlooked.
 *    `job_workflow_id` hashes `[connector, job, payload]` and deliberately excludes the requester,
 *    so two chemists asking for the identical campaign rejoin one run — which therefore has no
 *    owner, and cancelling it cancels it for both. The 403 is a statement about the caller's role,
 *    so it renders as a `warn` explanation carrying the service's own sentence, not as a red
 *    failure the reader should retry.
 *  - A 202 means the request was **delivered**, not that the run stopped. Temporal's cancellation
 *    is cooperative: the workflow unwinds through its own teardown whenever it next can. So the
 *    button never flips to "cancelled" — it flips to "cancellation requested" and hands over the
 *    only thing that can answer the question, which is re-reading the status.
 */
function CancelControl({
  jobId,
  live,
  onPolled,
}: {
  jobId: string;
  live: boolean;
  onPolled: () => void;
}): React.JSX.Element | null {
  const { auth } = useAuth();
  const [requested, setRequested] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!live && !requested && refused === null && failed === null) return null;

  const ask = async (): Promise<void> => {
    setBusy(true);
    setRefused(null);
    setFailed(null);
    try {
      await api.requestJobCancel(jobId, () => auth.getAccessToken());
      setRequested(true);
    } catch (err) {
      // 403 is not a failure of the request; it is the answer to it. `errors.ts` has no kind for
      // it (the taxonomy covers the statuses the turn routes return), so the status is what
      // separates "you may not" from "something broke".
      if (err instanceof ApiError && err.status === 403) setRefused(err.message);
      else setFailed(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      {live && !requested && (
        <Button tone="danger" onClick={() => void ask()} disabled={busy}>
          {busy ? 'Asking…' : 'Request cancellation'}
        </Button>
      )}

      {requested && (
        <Callout tone="warn" title="Cancellation requested — the run has not been confirmed stopped.">
          Temporal delivers the request to the workflow, which stops when its own teardown unwinds.
          Re-read the status above to find out how it actually ended.
          <div className="mt-2">
            <Button onClick={onPolled}>Re-read status</Button>
          </div>
        </Callout>
      )}

      {refused !== null && (
        <Callout tone="warn" title="Cancelling a durable run needs an operator role.">
          {refused}
        </Callout>
      )}

      {failed !== null && (
        <Callout tone="danger" title="The cancel request did not reach the service.">
          {failed}
        </Callout>
      )}
    </div>
  );
}
