/**
 * Knowledge waiting on a human.
 *
 * A **proposal** is machine-written knowledge waiting to enter the graph. Deciding it commits or
 * refuses bytes in a repository, and the service calls this gate "the line that makes
 * machine-written knowledge safe".
 *
 * The screen shows proposals to everyone. Only the decision controls are role-gated, because
 * `GET /proposals` already narrows what a non-reviewer sees to their own, and a chemist reading
 * why their note was rejected is exactly who this page is for.
 *
 * **This screen used to carry a second section, for durable interaction "holds".** It is gone,
 * and the reason is worth keeping: the service deleted that whole mechanism
 * (`D-2026-08-27-a-hold-nothing-can-open-is-not-a-hold`) because nothing could ever open one, so
 * `GET /approvals` now 404s. The list call swallowed that into `[]`, which meant this page showed
 * a confident, permanently empty inbox describing a decision that could not occur — the exact
 * "a control that reads as real and is not" failure the deletion upstream was written against.
 *
 * The slot is deliberately left empty rather than refilled here. The gate that *does* block work
 * is the plan approval, which is answered per session on `POST /sessions/{id}/plan/decision` and
 * currently lives only as an inline card in a live turn — so it survives no reload. Giving it a
 * home on this page is a real change with a real design behind it, not a rename of a dead one.
 */

import { useCallback, useEffect, useState } from 'react';
import { FileCheck2 } from 'lucide-react';
import { useAuth, useIsReviewer } from '../auth/AuthContext.tsx';
import { api, type ProposalDetail, type ProposalSummary } from '../api/client.ts';
import { relativeTime } from '../lib/format.ts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { ConfirmDialog } from '@/components/chem/ConfirmDialog';
import { EmptyState, Loading } from '@/components/chem/Feedback';

const STATE_TONE: Record<string, 'ok' | 'danger' | 'warn'> = {
  approved: 'ok',
  rejected: 'danger',
  pending: 'warn',
};

/** Turn a service timestamp into "3 hours ago", or nothing when there is none to turn. */
function when(value: string | null): string {
  if (!value) return '';
  const at = new Date(value).getTime();
  return Number.isNaN(at) ? '' : relativeTime(at);
}

/**
 * One proposal, with the bytes it would commit.
 *
 * The content is shown as the file it is, not as rendered markdown. A sign-off is on what lands in
 * the tree; rendering it would hide exactly the things a reviewer is checking for — the front
 * matter, the wikilinks, the confidence field.
 */
function ProposalSheet({
  id,
  open,
  onOpenChange,
  onDecided,
}: {
  id: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDecided: () => void;
}): React.JSX.Element {
  const { auth } = useAuth();
  const isReviewer = useIsReviewer();
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadedFor, setLoadedFor] = useState<number | null>(null);

  if (open && loadedFor !== id) {
    setLoadedFor(id);
    setDetail(null);
    setError(null);
    setReason('');
    api
      .getProposal(id, auth)
      .then(setDetail)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Could not read that proposal.'),
      );
  }

  const decide = (approved: boolean) => async (): Promise<void> => {
    setBusy(true);
    try {
      await api.decideProposal(id, approved, reason, auth);
      onOpenChange(false);
      onDecided();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The decision was not recorded.');
    } finally {
      setBusy(false);
    }
  };

  const pending = detail?.state === 'pending';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" title="Proposed note" className="w-[min(48rem,95vw)]">
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
          {!detail && !error && <Loading>Reading the proposal…</Loading>}
          {error && (
            <p role="alert" className="text-sm text-danger-ink">
              {error}
            </p>
          )}

          {detail && (
            <>
              <div>
                <p className="font-mono text-xs break-all">{detail.note_id}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Badge tone={STATE_TONE[detail.state] ?? 'neutral'}>{detail.state}</Badge>
                  <Badge tone="neutral">{detail.note_type}</Badge>
                  <span className="text-2xs text-ink-subtle">
                    proposed by {detail.actor} {when(detail.submitted_at)}
                  </span>
                </div>
              </div>

              {detail.state !== 'pending' && (
                <p className="rounded-lg border border-border-subtle bg-surface-sunken px-3 py-2 text-xs">
                  {detail.state} by {detail.decided_by || 'someone'} {when(detail.decided_at)}
                  {detail.reason && <> — {detail.reason}</>}
                </p>
              )}

              <div>
                <h3 className="mb-1.5 text-2xs font-medium tracking-wide text-ink-subtle uppercase">
                  What would be committed
                </h3>
                {/* Focusable: it scrolls, and a scroll region nothing can focus is unreachable
                    from a keyboard. */}
                <pre
                  tabIndex={0}
                  role="region"
                  aria-label="The note as it would be committed"
                  className="max-h-96 overflow-auto rounded-lg border border-border-subtle bg-surface-sunken p-3 font-mono text-2xs leading-relaxed whitespace-pre-wrap focus-ring"
                >
                  {detail.content}
                </pre>
              </div>

              {detail.dependencies.length > 0 && (
                <div>
                  <h3 className="mb-1.5 text-2xs font-medium tracking-wide text-ink-subtle uppercase">
                    And {detail.dependencies.length} file
                    {detail.dependencies.length === 1 ? '' : 's'} alongside it
                  </h3>
                  {/* Minted compound notes, usually. They land in the same commit, so they are
                      part of what is being signed off — not context. */}
                  <ul className="flex flex-col gap-2">
                    {detail.dependencies.map((file) => (
                      <li key={file.path}>
                        <details className="group rounded-lg border border-border-subtle">
                          <summary className="tap-target cursor-pointer list-none px-3 py-2 font-mono text-2xs focus-ring">
                            {file.path}
                          </summary>
                          <pre
                            tabIndex={0}
                            role="region"
                            aria-label={file.path}
                            className="max-h-64 overflow-auto border-t border-border-subtle p-3 font-mono text-2xs whitespace-pre-wrap focus-ring"
                          >
                            {file.content}
                          </pre>
                        </details>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <p className="text-2xs text-ink-subtle">
                branch <span className="font-mono">{detail.branch}</span> · correlation{' '}
                <span className="font-mono">{detail.correlation_id || 'not recorded'}</span>
              </p>

              {pending && !isReviewer && (
                <p className="rounded-lg border border-border-subtle bg-surface-sunken px-3 py-2 text-xs text-ink-muted">
                  Deciding a proposal needs a reviewer role. You can read it and see what it would
                  commit; someone holding the role signs it in.
                </p>
              )}

              {pending && isReviewer && (
                <div className="flex flex-col gap-3 border-t border-border-subtle pt-4">
                  <label className="flex flex-col gap-1.5 text-xs">
                    <span className="font-medium">
                      Reason{' '}
                      <span className="font-normal text-ink-subtle">(required to reject)</span>
                    </span>
                    {/* Required on a rejection by the service, which 422s a blank one — and
                        rightly: a note refused without a stated reason tells the next reviewer,
                        and the agent, nothing. */}
                    <textarea
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      rows={2}
                      className="resize-y rounded-lg border border-border-subtle bg-surface px-2.5 py-2 outline-none focus-ring"
                      placeholder="Why this does or does not belong in the record"
                    />
                  </label>

                  <div className="flex flex-wrap gap-2">
                    <ConfirmDialog
                      trigger={
                        <Button variant="success" size="sm" disabled={busy}>
                          Approve
                        </Button>
                      }
                      title="Sign this note into the record?"
                      description="It will be merged into the knowledge graph and cited by future answers. The decision is attributable to you and cannot be undone here."
                      confirmLabel="Approve"
                      onConfirm={() => void decide(true)()}
                    />
                    <ConfirmDialog
                      trigger={
                        <Button
                          variant="outline-destructive"
                          size="sm"
                          disabled={busy || !reason.trim()}
                        >
                          Reject
                        </Button>
                      }
                      title="Refuse this note?"
                      description="The proposal is closed and the note does not enter the graph. Your reason is recorded with the decision."
                      confirmLabel="Reject"
                      variant="destructive"
                      onConfirm={() => void decide(false)()}
                    />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Proposals(): React.JSX.Element {
  const { auth, ready } = useAuth();
  const [proposals, setProposals] = useState<ProposalSummary[] | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void api
      .listProposals(auth, { state: 'pending' })
      .then((list) => !cancelled && setProposals(list))
      .catch(() => !cancelled && setProposals([]));
    return () => {
      cancelled = true;
    };
  }, [auth, ready, nonce]);

  if (!proposals) return <Loading>Reading the review queue…</Loading>;
  if (proposals.length === 0) {
    return (
      <EmptyState icon={<FileCheck2 className="size-5" />} title="No notes are waiting for review">
        Everything the agent has proposed has been decided. A new proposal appears here the moment a
        turn opens one.
      </EmptyState>
    );
  }

  return (
    <>
      <ul className="flex flex-col gap-2">
        {proposals.map((proposal) => (
          <li key={proposal.id}>
            <button
              type="button"
              onClick={() => setOpenId(proposal.id)}
              className="w-full rounded-lg border border-border-subtle bg-surface-raised p-3 text-left transition-colors hover:bg-surface-sunken focus-ring"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs break-all">{proposal.note_id}</span>
                <Badge tone="neutral">{proposal.note_type}</Badge>
                <Badge tone={STATE_TONE[proposal.state] ?? 'neutral'}>{proposal.state}</Badge>
              </div>
              <p className="mt-1 text-2xs text-ink-subtle">
                proposed by {proposal.actor} {when(proposal.submitted_at)}
              </p>
            </button>
          </li>
        ))}
      </ul>
      {openId !== null && (
        <ProposalSheet
          id={openId}
          open
          onOpenChange={(next) => !next && setOpenId(null)}
          onDecided={reload}
        />
      )}
    </>
  );
}

export function ReviewQueue(): React.JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <section aria-labelledby="proposals-heading">
          <h2 id="proposals-heading" className="mb-1 text-lg font-semibold tracking-tight">
            Notes waiting for review
          </h2>
          <p className="mb-3 text-sm text-ink-muted">
            Knowledge the agent wrote, held at the gate until a human signs it into the graph.
          </p>
          <Proposals />
        </section>
      </div>
    </div>
  );
}
