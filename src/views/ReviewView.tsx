/**
 * The PR-gate's review queue.
 *
 * This is the "AI proposes, a human signs off" line the architecture is built around, and until
 * now it had no UI at all: a note was pushed to a `note/<id>` branch and browsing refs in a git
 * host was the only way to find out anything had been proposed.
 *
 * Two things this view refuses to make convenient, because the backend refuses to as well:
 *
 *  - A rejection must state why. The service 422s an empty reason, and it is right to: before this
 *    table existed a rejection left no trace at all, and a record that says only "no" would
 *    reproduce that gap one level up. So the reason box is required for Reject and the button
 *    stays disabled until it is filled.
 *  - Dependencies are part of what is being approved. `ProposalDetail.dependencies` is the rest of
 *    the submission — the `compound` note a `job-result` cites — and a note plus the notes its
 *    links depend on is one reviewable unit. Showing the subject note alone invites approving a
 *    link whose far end nobody looked at, so they are rendered here, not hidden behind a count.
 */

import { useState } from 'react';
import { api, type ProposalDetail, type ProposalSummary } from '../api/client.ts';
import { ApiError } from '../api/errors.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { cn } from '../lib/cn.ts';
import { NoteView } from './NoteView.tsx';
import { Button, Callout, Page, Pill, When, type Tone } from './ui.tsx';
import { errorText, useResource } from './useResource.ts';

const STATE_TONE: Record<string, Tone> = {
  open: 'accent',
  merged: 'ok',
  rejected: 'warn',
};

const FILTERS = [
  ['open', 'Open'],
  ['merged', 'Merged'],
  ['rejected', 'Rejected'],
  ['', 'All'],
] as const;

export function ReviewView(): React.JSX.Element {
  const [state, setState] = useState<string>('open');
  const [selected, setSelected] = useState<number | null>(null);
  const queue = useResource<ProposalSummary[]>(
    (getToken) => api.listProposals(getToken, state),
    [state],
  );

  return (
    <Page
      title="Review queue"
      subtitle="Notes the agent proposed, and what became of them. A reviewer sees every proposal; anyone else sees their own."
      actions={
        <Button onClick={queue.reload} disabled={queue.loading}>
          {queue.loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      }
    >
      <div className="mb-3 flex flex-wrap gap-1.5">
        {FILTERS.map(([value, label]) => (
          <button
            key={label}
            type="button"
            onClick={() => {
              setState(value);
              setSelected(null);
            }}
            className={cn(
              'rounded border px-2 py-0.5 text-sm',
              value === state
                ? 'border-accent/50 bg-accent-soft text-accent'
                : 'border-border-subtle bg-surface-raised text-ink-muted hover:text-ink',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {queue.error !== undefined && (
        <Callout tone="danger" title="The review queue could not be read.">
          {errorText(queue.error)} An empty list below would have meant nothing is waiting; this
          means we do not know.
        </Callout>
      )}

      {queue.data?.length === 0 && queue.error === undefined && (
        <Callout tone="neutral">Nothing in this state.</Callout>
      )}

      <ul className="space-y-1.5">
        {(queue.data ?? []).map((proposal) => (
          <li key={proposal.id}>
            <button
              type="button"
              onClick={() => setSelected(selected === proposal.id ? null : proposal.id)}
              className={cn(
                'w-full rounded-md border px-3 py-2 text-left transition-colors',
                selected === proposal.id
                  ? 'border-accent/50 bg-accent-soft'
                  : 'border-border-subtle bg-surface-raised hover:brightness-95',
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={STATE_TONE[proposal.state] ?? 'neutral'}>{proposal.state}</Pill>
                <span className="font-mono text-sm">{proposal.note_id}</span>
                <span className="text-xs text-ink-muted">{proposal.note_type}</span>
                <span className="ml-auto text-xs">
                  <When iso={proposal.submitted_at} />
                </span>
              </div>
              <p className="mt-1 text-xs text-ink-muted">
                proposed by {proposal.actor || 'unknown'}
                {proposal.decided_by && ` · decided by ${proposal.decided_by}`}
              </p>
              {proposal.reason && <p className="mt-1 text-sm">{proposal.reason}</p>}
            </button>

            {selected === proposal.id && (
              <ProposalPanel
                proposalId={proposal.id}
                onDecided={() => {
                  setSelected(null);
                  queue.reload();
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </Page>
  );
}

function ProposalPanel({
  proposalId,
  onDecided,
}: {
  proposalId: number;
  onDecided: () => void;
}): React.JSX.Element {
  const detail = useResource<ProposalDetail>(
    (getToken) => api.getProposal(proposalId, getToken),
    [proposalId],
  );

  return (
    <div className="mt-1.5 mb-3 rounded-md border border-border-subtle bg-surface-sunken p-3">
      {detail.loading && !detail.data && <p className="text-sm text-ink-muted">Reading…</p>}

      {detail.error !== undefined && (
        <Callout tone="danger" title="This proposal could not be read.">
          {errorText(detail.error)}
        </Callout>
      )}

      {detail.data && (
        <div className="space-y-3">
          <NoteView content={detail.data.content} />

          {(detail.data.dependencies ?? []).length > 0 && (
            <div>
              <h3 className="mb-1.5 text-xs font-medium tracking-wide text-ink-muted uppercase">
                Also written by this submission ({detail.data.dependencies?.length})
              </h3>
              <div className="space-y-2">
                {(detail.data.dependencies ?? []).map((dependency) => (
                  <NoteView
                    key={dependency.path}
                    content={dependency.content}
                    path={dependency.path}
                  />
                ))}
              </div>
            </div>
          )}

          {/* The audit trail's two handles. A reviewer asking "where did this come from?" needs
              the conversation and the correlation id, and neither is derivable from the note. */}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            <dt className="text-ink-muted">branch</dt>
            <dd className="font-mono break-all">{detail.data.branch || '—'}</dd>
            <dt className="text-ink-muted">reference</dt>
            <dd className="font-mono break-all">{detail.data.reference || '—'}</dd>
            <dt className="text-ink-muted">session</dt>
            <dd className="font-mono break-all">{detail.data.session_id || '—'}</dd>
            <dt className="text-ink-muted">correlation</dt>
            <dd className="font-mono break-all">{detail.data.correlation_id || '—'}</dd>
          </dl>

          {detail.data.state === 'open' ? (
            <DecisionForm proposalId={proposalId} onDecided={onDecided} />
          ) : (
            <Callout tone="neutral">
              Decided {detail.data.decided_by ? `by ${detail.data.decided_by}` : ''} — this row is
              closed and the service refuses a second decision on it.
            </Callout>
          )}
        </div>
      )}
    </div>
  );
}

function DecisionForm({
  proposalId,
  onDecided,
}: {
  proposalId: number;
  onDecided: () => void;
}): React.JSX.Element {
  const { auth } = useAuth();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  const decide = async (approved: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    setRefused(null);
    setConflict(null);
    try {
      await api.decideProposal(proposalId, approved, reason.trim(), () => auth.getAccessToken());
      onDecided();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setRefused(err.message);
      // 409 here means somebody else decided this row while it was open on screen. It is NOT the
      // plan gate's 409 (a plan that changed), so it is not re-kinded and the right move is to
      // re-read the queue rather than to re-submit.
      else if (err instanceof ApiError && err.status === 409) setConflict(err.message);
      else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-border-subtle bg-surface-raised p-3">
      <label htmlFor={`reason-${proposalId}`} className="block text-sm font-medium">
        Reason
        <span className="ml-1 font-normal text-ink-muted">
          — required to reject, kept on the record either way
        </span>
      </label>
      <textarea
        id={`reason-${proposalId}`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        rows={2}
        className="w-full rounded border border-border-subtle bg-surface p-2 text-sm"
        placeholder="Why this note should (or should not) become knowledge."
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button tone="ok" onClick={() => void decide(true)} disabled={busy}>
          Approve
        </Button>
        <Button
          tone="danger"
          onClick={() => void decide(false)}
          disabled={busy || reason.trim() === ''}
          title={reason.trim() === '' ? 'A rejection must state why — that is what the record is for.' : undefined}
        >
          Reject
        </Button>
        {busy && <span className="text-sm text-ink-muted">Recording…</span>}
      </div>

      {/* Approving here records the sign-off; the merge itself happens in the git host, and the
          `knowledge-merged` webhook closes the row when the host reports it. Saying so keeps the
          button from reading as "this note is now in the graph". */}
      <p className="text-xs text-ink-muted">
        Approving records the decision. The merge happens in the git host, and the row closes when
        the host reports it back.
      </p>

      {refused !== null && (
        <Callout tone="warn" title="Deciding a proposal needs a review role.">
          {refused}
        </Callout>
      )}
      {conflict !== null && (
        <Callout tone="warn" title="Already decided.">
          {conflict} Refresh the queue to see what it was decided as.
        </Callout>
      )}
      {error !== null && (
        <Callout tone="danger" title="The decision was not recorded.">
          {error}
        </Callout>
      )}
    </div>
  );
}
