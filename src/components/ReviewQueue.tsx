/**
 * What is waiting on a human — across every conversation, not inside one.
 *
 * Two gates, two sections, and the difference between them is what the page is for.
 *
 * A **proposal** is machine-written knowledge waiting to enter the graph. Deciding it commits or
 * refuses bytes in a repository, and the service calls this gate "the line that makes
 * machine-written knowledge safe".
 *
 * A **plan** is work the agent cannot start. Under `harness_autonomy="plan_only"` every
 * state-changing step is refused until a human approves the exact plan they were shown, and until
 * this section existed that decision was reachable only from inside the turn that raised it: the
 * card lives in a live conversation, a reload recovers it only for a conversation somebody opens,
 * and a chemist who closed the tab holds no session id. So a plan could sit blocking work with
 * nothing anywhere able to say which conversation it was in. `GET /plans/pending` is the route
 * that answers it, and this is the only screen that asks.
 *
 * **The section it replaces is why the counts are rendered.** This page used to carry an inbox for
 * durable interaction "holds". The service deleted that whole mechanism
 * (`D-2026-08-27-a-hold-nothing-can-open-is-not-a-hold`) because nothing could ever open one, and
 * the list call swallowed the resulting 404 into `[]` — so the page showed a confident,
 * permanently empty inbox describing a decision that could not occur. An empty list is not a
 * finding on its own, so this one never renders as one: the service reports what its scan covered,
 * and an empty `plans` says whether the deployment gates plans at all and whether the answer was
 * complete. A failed call says it failed.
 *
 * **It does not decide in place.** The service binds a decision to the hash of the plan as
 * displayed, so deciding from here would be safe; it would not be *informed*. A plan is approved
 * on the strength of the reasoning that produced it, which is one click away in the conversation
 * — the same argument the deleted holds section made for linking back rather than answering here.
 */

import { useCallback, useEffect, useState } from 'react';
import { FileCheck2, ListChecks } from 'lucide-react';
import { Link } from 'react-router';
import { useAuth, useIsReviewer } from '../auth/AuthContext.tsx';
import {
  api,
  type PendingPlans as PendingPlansView,
  type ProposalDetail,
  type ProposalSummary,
} from '../api/client.ts';
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

/**
 * Why this list is empty — the sentence the deleted holds inbox could not say.
 *
 * Three emptinesses, and only the last one means "you are up to date". Separating them is the
 * whole reason the service returns counts beside the rows.
 */
function NoPlansWaiting({ view }: { view: PendingPlansView }): React.JSX.Element {
  if (view.considered === 0) {
    return (
      <EmptyState icon={<ListChecks className="size-5" />} title="No conversations to check">
        This service holds no conversation of yours yet. A plan can only wait on you once the agent
        has proposed one.
      </EmptyState>
    );
  }
  if (view.gated === 0) {
    return (
      <EmptyState icon={<ListChecks className="size-5" />} title="Nothing here asks before it acts">
        None of your conversations runs under a profile that holds work for approval, so no plan can
        be waiting. This is how the deployment is configured, not an empty queue.
      </EmptyState>
    );
  }
  return (
    <EmptyState icon={<ListChecks className="size-5" />} title="No plan is waiting on you">
      Every plan the agent has proposed has been answered. One appears here as soon as a turn ends
      holding work it may not start.
    </EmptyState>
  );
}

/** How much of the answer is missing, said plainly — a short list that looks complete is worse. */
function PartialScan({ unread }: { unread: number }): React.JSX.Element | null {
  if (unread === 0) return null;
  return (
    <p role="status" className="text-xs text-ink-muted">
      {unread} older {unread === 1 ? 'conversation was' : 'conversations were'} not checked, so this
      list may be short. Open one from the sidebar to see its plan.
    </p>
  );
}

/**
 * Plans this chemist has not decided, in every conversation at once.
 *
 * The failure is surfaced rather than folded into an empty list: `api.listPendingPlans` lets the
 * error through for exactly this, because "we could not ask" and "nothing is waiting" are opposite
 * things to tell somebody whose work is blocked.
 */
function PlanInbox(): React.JSX.Element {
  const { auth, ready } = useAuth();
  const [view, setView] = useState<PendingPlansView | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void api
      .listPendingPlans(auth)
      .then((next) => {
        if (cancelled) return;
        setView(next);
        setFailed(false);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [auth, ready]);

  if (failed) {
    return (
      <p role="alert" className="text-sm text-danger-ink">
        The service could not be asked which plans are waiting. This is not the same as nothing
        waiting — a plan already approved still executes, and one that is not still blocks.
      </p>
    );
  }
  if (!view) return <Loading>Reading the plan gate…</Loading>;
  if (view.plans.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <NoPlansWaiting view={view} />
        <PartialScan unread={view.unread} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {view.plans.map((pending) => (
          <li
            key={pending.session_id}
            className="rounded-lg border border-warn/40 bg-surface-raised p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{pending.title ?? 'Untitled conversation'}</span>
              <Badge tone="warn">
                {pending.plan.length} {pending.plan.length === 1 ? 'step' : 'steps'}
              </Badge>
              <span className="text-2xs text-ink-subtle">
                last active {when(pending.updated_at)}
              </span>
            </div>
            {/* The steps themselves, not a count of them: what is being approved is the work, and
                a row that hid it would send a chemist into the conversation to find out whether it
                is even the one they are looking for. */}
            <ol className="mt-2 flex list-decimal flex-col gap-1 pl-5 text-sm text-ink-muted">
              {pending.plan.map((step, index) => (
                <li key={`${index}-${step}`}>{step}</li>
              ))}
            </ol>
            <div className="mt-3">
              <Button asChild size="sm" variant="outline">
                {/* `/s/:sessionId` adopts the server session into a local conversation, which is
                    the only route that can turn an id from this list into something readable. The
                    decision is answered there, beside the reasoning that produced the plan. */}
                <Link to={`/s/${pending.session_id}`}>Open the conversation to decide</Link>
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <PartialScan unread={view.unread} />
    </div>
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
        {/* First, because it is the section that blocks work: a proposal waits, a plan stops. */}
        <section aria-labelledby="plans-heading">
          <h2 id="plans-heading" className="mb-1 text-lg font-semibold tracking-tight">
            Plans waiting on you
          </h2>
          <p className="mb-3 text-sm text-ink-muted">
            Work the agent has planned and may not start until you approve it — from every
            conversation, including the ones you have closed.
          </p>
          <PlanInbox />
        </section>

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
