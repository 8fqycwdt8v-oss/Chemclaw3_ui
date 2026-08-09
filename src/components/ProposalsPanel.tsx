/**
 * The PR gate's review queue: what the agent has proposed, and signing off on it.
 *
 * The gate — "AI proposes, a human signs off" — is named across the backend's architecture,
 * security and decision records as the line that makes machine-written knowledge safe. It had no
 * surface here at all: the `note_proposed` event told a chemist their contribution had been opened
 * on a branch, and that was the end of it. Reviewing meant browsing refs in a git host.
 *
 * Three backend properties shape this, and each is stated rather than smoothed over:
 *
 *   - **A proposal is a multi-file unit.** `dependencies` carries the other files it touches, so a
 *     surface rendering only `content` is asking someone to approve a partial submission.
 *   - **A rejection must state why.** The backend answers 422 without a reason, deliberately: a
 *     rejection is a deleted branch, so the recorded reason is the only trace it leaves.
 *   - **Visibility is not ownership.** A reviewer sees every proposal; everyone else sees only
 *     their own, and an invisible one is a 404 rather than a 403 so its existence does not leak.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, type ProposalDetail, type ProposalSummary } from '../api/client.ts';
import { ApiError } from '../api/errors.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { cn } from '../lib/cn.ts';

const STATES = ['open', 'merged', 'rejected', 'failed'] as const;

function stateTone(state: string): string {
  if (state === 'merged') return 'text-ok';
  if (state === 'rejected' || state === 'failed') return 'text-danger';
  return 'text-warn';
}

function DecisionForm({
  proposal,
  onDecided,
  token,
}: {
  proposal: ProposalDetail;
  onDecided: () => void;
  token: () => Promise<string | null>;
}): React.JSX.Element {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (approved: boolean): Promise<void> => {
    // Checked here as well as upstream so the reviewer is told before the round trip, not by a
    // 422 they have to interpret.
    if (!approved && !reason.trim()) {
      setError('A rejection must say why — that is what the record is for.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.decideProposal(proposal.id, approved, reason.trim(), token);
      onDecided();
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'forbidden') {
        setError('Deciding a proposal needs a review role.');
      } else if (err instanceof ApiError && err.status === 409) {
        setError('This proposal has already been decided.');
      } else {
        setError(err instanceof Error ? err.message : 'Could not record that decision.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 border-t border-border-subtle pt-3">
      <label htmlFor={`reason-${proposal.id}`} className="block text-xs text-ink-muted">
        Reason (required to reject)
      </label>
      <textarea
        id={`reason-${proposal.id}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        aria-label="Reason for this decision"
        className="mt-1 w-full rounded border border-border-subtle bg-surface p-2 text-sm focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide(true)}
          className="rounded border border-ok/40 bg-ok-soft px-3 py-1 text-sm text-ok disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        >
          {busy ? 'Recording…' : 'Approve'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide(false)}
          className="rounded border border-danger/40 bg-danger-soft px-3 py-1 text-sm text-danger disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        >
          Reject
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function ProposalsPanel(): React.JSX.Element {
  const { auth } = useAuth();
  const [state, setState] = useState<string>('open');
  const [items, setItems] = useState<ProposalSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ProposalDetail | null>(null);

  const token = useCallback(() => auth.getAccessToken(), [auth]);

  // Same shape as JobsPanel: reloads bump a token so the fetch stays inside the effect and can
  // drop a response that arrives after unmount or after a newer request.
  const [reloadToken, setReloadToken] = useState(0);
  const reload = (): void => setReloadToken((n) => n + 1);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const next = await api.listProposals(token, { state });
        if (!live) return;
        setItems(next);
        setError(null);
      } catch (err) {
        if (!live) return;
        setError(err instanceof Error ? err.message : 'Could not load the review queue.');
        setItems([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [token, state, reloadToken]);

  useEffect(() => {
    if (openId === null) return;
    let live = true;
    void (async () => {
      try {
        const full = await api.getProposal(openId, token);
        if (live) setDetail(full);
      } catch {
        if (live) setDetail(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [openId, token]);

  // Derived, not cleared from the effect above: a stale detail is simply one whose id no longer
  // matches what is open, which is a comparison rather than a state write.
  const openDetail = detail !== null && detail.id === openId ? detail : null;

  return (
    <section aria-labelledby="proposals-heading" className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2">
        <h2 id="proposals-heading" className="text-sm font-medium">
          Proposed notes
        </h2>
        <div className="flex gap-1" role="group" aria-label="Filter by state">
          {STATES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={state === s}
              onClick={() => setState(s)}
              className={cn(
                'rounded px-2 py-0.5 text-xs focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
                state === s ? 'bg-accent-soft text-accent' : 'text-ink-muted hover:text-ink',
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <p aria-live="polite" className="sr-only">
        {items === null ? 'Loading proposals' : `${items.length} proposals`}
      </p>

      <div className="flex-1 overflow-y-auto px-4 py-2">
        {items === null && <p className="text-sm text-ink-muted">Loading…</p>}
        {error && <p className="text-sm text-danger">{error}</p>}
        {items !== null && items.length === 0 && !error && (
          <p className="text-sm text-ink-muted">Nothing {state}.</p>
        )}

        <ul className="space-y-2">
          {(items ?? []).map((p) => (
            <li key={p.id} className="rounded-md border border-border-subtle bg-surface-raised p-3">
              <button
                type="button"
                aria-expanded={openId === p.id}
                onClick={() => setOpenId(openId === p.id ? null : p.id)}
                className="w-full text-left focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
              >
                <p className="text-sm font-medium">
                  {p.note_id}
                  <span className="ml-1.5 text-xs text-ink-muted">{p.note_type}</span>
                </p>
                <p className="text-xs">
                  <span className={stateTone(p.state)}>{p.state}</span>
                  <span className="ml-1.5 text-ink-muted">by {p.actor}</span>
                  {p.decided_by && (
                    <span className="ml-1.5 text-ink-muted">· decided by {p.decided_by}</span>
                  )}
                </p>
                {p.reason && <p className="mt-1 text-xs text-ink-muted">“{p.reason}”</p>}
              </button>

              {openId === p.id && (
                <div className="mt-2 border-t border-border-subtle pt-2">
                  {openDetail === null ? (
                    <p className="text-xs text-ink-muted">Loading the note…</p>
                  ) : (
                    <>
                      <pre className="max-h-64 overflow-auto rounded bg-surface-sunken p-2 font-mono text-xs whitespace-pre-wrap">
                        {openDetail.content}
                      </pre>
                      {openDetail.dependencies.length > 0 && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-xs text-ink-muted">
                            {openDetail.dependencies.length} other file
                            {openDetail.dependencies.length === 1 ? '' : 's'} in this proposal
                          </summary>
                          {openDetail.dependencies.map((file) => (
                            <div key={file.path} className="mt-1.5">
                              <p className="font-mono text-[0.7rem] text-ink-muted">{file.path}</p>
                              <pre className="max-h-40 overflow-auto rounded bg-surface-sunken p-2 font-mono text-xs whitespace-pre-wrap">
                                {file.content}
                              </pre>
                            </div>
                          ))}
                        </details>
                      )}
                      {openDetail.state === 'open' && (
                        <DecisionForm
                          proposal={openDetail}
                          token={token}
                          onDecided={() => {
                            setOpenId(null);
                            reload();
                          }}
                        />
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
