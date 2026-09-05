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
import { FileCheck2, Inbox, ListChecks } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { useAuth, useIsReviewer } from '../auth/AuthContext.tsx';
import {
  api,
  type PendingRequest,
  type PendingRequests as PendingRequestsView,
  type PendingPlans as PendingPlansView,
  type ProposalDetail,
  type ProposalSummary,
} from '../api/client.ts';
import { ApiError } from '../api/errors.ts';
import { useNewestRead } from '../hooks/useNewestRead.ts';
import { relativeTime } from '../lib/format.ts';
import { useChatStore } from '../state/chatStore.ts';
import { CitationChip } from './CitationChip.tsx';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { ConfirmDialog } from '@/components/chem/ConfirmDialog';
import { EmptyState, Loading } from '@/components/chem/Feedback';

/**
 * The service's own listing cap, mirrored so a full page can be recognised as one.
 *
 * `proposal_list_limit` on the service side. A copy rather than something discovered, for the same
 * reason `maxMessageChars` is told to this app rather than fetched: the service publishes no route
 * carrying it. Being wrong here is cheap in exactly one direction — too low and a "Load older"
 * control appears with nothing behind it, which the first empty page then removes.
 */
const PAGE_IS_FULL = 50;

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
  const claim = useNewestRead();

  if (open && loadedFor !== id) {
    setLoadedFor(id);
    setDetail(null);
    setError(null);
    setReason('');
    // Claimed before the request, so a read this one supersedes cannot land afterwards. What this
    // sheet renders is the bytes an Approve would commit, and Approve posts `id` — a proposal's
    // content under another proposal's identity is a sign-off on something nobody read. See
    // `useNewestRead`.
    const isNewest = claim();
    api
      .getProposal(id, auth)
      .then((next) => isNewest() && setDetail(next))
      .catch((err: unknown) => {
        if (!isNewest()) return;
        setError(err instanceof Error ? err.message : 'Could not read that proposal.');
      });
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

/**
 * How much of the answer is missing, said plainly — a short list that looks complete is worse.
 *
 * **Two different shortfalls, and the service reports them apart because they are not one claim.**
 * `unread` counts *gated* conversations whose plan the scan did not get to. `truncated` is the
 * walk through the listing stopping before the end, so it carries no count at all: the service
 * never learned whether the conversations beyond it are gated, and folding them into `unread`
 * would be inventing plans that may not exist. Reading only the first left the second invisible —
 * a service that stopped looking rendered exactly like one that had finished, which is the
 * confident emptiness this whole section exists to refuse.
 */
function PartialScan({ view }: { view: PendingPlansView }): React.JSX.Element | null {
  // `=== true` rather than truthiness: the field is additive, so a service that predates it sends
  // nothing, and "not reported" must not become a claim in either direction.
  const stopped = view.truncated === true;
  if (view.unread === 0 && !stopped) return null;
  const unchecked =
    view.unread > 0
      ? `${view.unread} older ${view.unread === 1 ? 'conversation was' : 'conversations were'} not checked`
      : '';
  const sentence = unchecked
    ? stopped
      ? `${unchecked}, and the scan stopped before the end of your conversations, so this list may be short.`
      : `${unchecked}, so this list may be short.`
    : 'The scan stopped before the end of your conversations, so this list may be short.';
  return (
    <p role="status" className="text-xs text-ink-muted">
      {sentence} Open one from the sidebar to see its plan.
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
        <PartialScan view={view} />
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
      <PartialScan view={view} />
    </div>
  );
}

/**
 * What the standing queries turned up, claimed once and kept.
 *
 * `GET /digests` was built, registered and never called from here — `USER-STORIES.md` H4 still
 * records the whole story as blocked on the backend, and only its *creation* half is.
 *
 * **The read is the consume, and that decides the shape of this component.** The service's mailbox
 * claim is destructive: a row returned here is marked consumed and never re-delivered. So the
 * claim happens once, at the top of the app, straight into the persisted store — not from an
 * effect on this screen, which would destroy a digest for anyone who opened `/review` and
 * navigated away before the response landed. This renders what was already claimed.
 *
 * Dismissal is a flag rather than a delete, because this card is now the only copy there is.
 */
function Digests(): React.JSX.Element | null {
  const digests = useChatStore((s) => s.digests);
  const dismiss = useChatStore((s) => s.dismissDigest);
  const visible = digests
    .map((digest, index) => ({ digest, index }))
    .filter(({ digest }) => !digest.dismissed);

  if (visible.length === 0) return null;

  return (
    <section aria-labelledby="digests-heading">
      <h2 id="digests-heading" className="mb-1 text-lg font-semibold tracking-tight">
        New knowledge from your standing queries
      </h2>
      <p className="mb-3 text-sm text-ink-muted">
        Notes that have entered the graph since a watch of yours last reported. Read once — the
        service does not keep a second copy, so these stay here until you dismiss them.
      </p>
      <ul className="flex flex-col gap-2">
        {visible.map(({ digest, index }) => (
          <li
            key={`${digest.receivedAt}-${index}`}
            className="rounded-lg border border-border-subtle bg-surface-raised p-3"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm">
                  <span className="text-ink-muted">watching </span>
                  <span className="font-medium">{digest.query || 'a saved query'}</span>
                </p>
                {/* "Seen", not "found": the service sends no timestamp for the merge, and a card
                    that implied one would be inventing it — the same rule `JobFeed` follows. */}
                <p className="mt-0.5 text-2xs text-ink-subtle">
                  seen {relativeTime(digest.receivedAt)} · {digest.noteIds.length}{' '}
                  {digest.noteIds.length === 1 ? 'note' : 'notes'}
                </p>
              </div>
              <Button size="xs" variant="ghost" onClick={() => dismiss(index)}>
                Dismiss
              </Button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {digest.noteIds.map((noteId) => (
                <CitationChip key={noteId} kind="note" id={noteId} />
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Questions the agent is holding a workflow open for.
 *
 * The third gate, and the one that had no surface at all. `GET /pending` has **three live
 * producers** — the `request_external_input` agent tool, `BoCampaignWorkflow._measure` pausing a
 * campaign at the bench for measured yields, and the connector-job path — and none of them could
 * reach a chemist: the request became a durable job that ran for seven days and expired.
 *
 * **This is not the `/approvals` inbox that was deleted.** That one had three consumers and no
 * producer, and swallowed its own 404 into `[]`, so it rendered a confident, permanently empty
 * inbox describing a decision that could not occur. The difference is the producers, and the
 * failure is surfaced rather than folded into an empty list, for the same reason `PlanInbox` does
 * it: "nothing is waiting" and "we could not ask" are opposite things to tell somebody whose bench
 * work is blocked.
 *
 * A campaign waiting on a yield is answered here as a number. Anything else is answered as text —
 * the service takes an opaque payload, and inventing a form per `kind` from a vocabulary this
 * client does not own would be guessing at a schema the workflow defines.
 */
function PendingInbox(): React.JSX.Element {
  const { auth, ready } = useAuth();
  const [view, setView] = useState<PendingRequestsView | null>(null);
  const [failed, setFailed] = useState(false);
  const [answering, setAnswering] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // The stream's own revision, not the list's length: `syncAwaiting` below must not be able to
  // re-trigger the effect that calls it. See `awaitingRevision` in the store.
  const pushes = useChatStore((s) => s.awaitingRevision);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void api
      .listPendingRequests(auth)
      .then((next) => {
        if (cancelled) return;
        setView(next);
        setFailed(false);
        // The service is the authority on what is open; the `awaiting_answer` stream only says
        // that something changed. Reconciling here is what keeps the sidebar badge honest after
        // an answer given in another tab, and what fills in the fields neither push carries whole.
        useChatStore
          .getState()
          .syncAwaiting(
            next.requests.filter((r) => r.state === 'waiting').map((r) => r.request_id),
          );
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
    // `pushes` is a dependency and not a value this reads: a frame off the push-back stream moves
    // it, which is the whole mechanism by which an inbox left open on screen notices a new question
    // without polling for one.
  }, [auth, ready, nonce, pushes]);

  const submit = (request: PendingRequest) => async (): Promise<void> => {
    setNotice(null);
    try {
      // A number when it parses as one, the raw text otherwise. A yield typed as "82" must not
      // reach a workflow expecting a measurement as the string "82".
      const parsed = Number(value.trim());
      const payload =
        value.trim() !== '' && Number.isFinite(parsed)
          ? { value: parsed }
          : { value: value.trim() };
      await api.answerPendingRequest(request.request_id, payload, auth);
      setAnswering(null);
      setValue('');
      setNotice('Answered. Whatever was waiting on it has been released.');
      setNonce((n) => n + 1);
    } catch (err: unknown) {
      // The 409 is the one worth spelling out: two chemists at one bench answering the same
      // question is ordinary, and the second must be told rather than have their answer dropped.
      setNotice(
        err instanceof ApiError && err.status === 409
          ? 'Somebody has already answered this one.'
          : err instanceof Error
            ? err.message
            : 'The answer was not delivered.',
      );
      setNonce((n) => n + 1);
    }
  };

  if (failed) {
    return (
      <p role="alert" className="text-sm text-danger-ink">
        The service could not be asked what is waiting on you. This is not the same as nothing
        waiting — a campaign paused for a measurement stays paused.
      </p>
    );
  }
  if (!view) return <Loading>Reading what is waiting…</Loading>;

  const waiting = view.requests.filter((r) => r.state === 'waiting');
  if (waiting.length === 0) {
    return (
      <EmptyState icon={<Inbox className="size-5" />} title="Nothing is waiting on you">
        A question appears here when the agent holds work open for an answer only a person can give
        — a measured yield, a decision about a batch, a value off an instrument.
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {notice && (
        <p
          role="status"
          className="rounded-lg border border-border-subtle bg-surface-sunken px-3 py-2 text-xs"
        >
          {notice}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {waiting.map((request) => (
          <li
            key={request.request_id}
            className="rounded-lg border border-warn/40 bg-surface-raised p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{request.subject}</span>
              <Badge tone="warn">{request.kind}</Badge>
              {request.due_at && (
                <span className="text-2xs text-ink-subtle">due {when(request.due_at)}</span>
              )}
            </div>
            {request.rationale && (
              <p className="mt-1.5 text-sm text-ink-muted">{request.rationale}</p>
            )}

            {answering === request.request_id ? (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-ink-muted">Your answer</span>
                  <input
                    // Focused on open through a ref rather than `autoFocus`: the prop moves focus
                    // on *mount*, which for a row rendered in a list is a jump a reader did not
                    // ask for — and `jsx-a11y` refuses it for that reason. This form appears
                    // because the reader clicked Answer, so moving focus into it is answering
                    // their action rather than pre-empting it.
                    ref={(el) => el?.focus()}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    className="rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5 outline-none focus-ring"
                  />
                </label>
                <ConfirmDialog
                  trigger={
                    <Button size="sm" disabled={!value.trim()}>
                      Send the answer
                    </Button>
                  }
                  title="Send this answer?"
                  description="The workflow waiting on this question resumes with what you have typed, attributed to you. It cannot be taken back."
                  confirmLabel="Send it"
                  onConfirm={() => void submit(request)()}
                />
                <Button size="sm" variant="ghost" onClick={() => setAnswering(null)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setAnswering(request.request_id);
                    setValue('');
                  }}
                >
                  Answer
                </Button>
                {request.session_id && (
                  <Button asChild size="sm" variant="ghost">
                    {/* The conversation that raised it, for the context the subject line cannot
                        carry — the same link the plan inbox offers, for the same reason. */}
                    <Link to={`/s/${request.session_id}`}>Open the conversation</Link>
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Proposals(): React.JSX.Element {
  const { auth, ready } = useAuth();
  // `/review/:proposalId` opens this queue with that proposal's sheet already up, so a reviewer can
  // be *sent* to one rather than told to find it. Coerced here because a path segment is a string
  // and every proposal route downstream takes a number.
  //
  // **And the URL is the only thing that says what is open.** This used to seed a `useState` from
  // the parameter, which made the address an *entry point* rather than the state: React Router
  // keeps this component mounted across `/review/7` → `/review/8`, so a second link — followed
  // from another tab, from Back or Forward, or from anywhere in the app — moved the address bar
  // and left the first proposal's sheet on screen. On a sign-off surface that is the worst
  // possible version of the bug: the reviewer reads one proposal at an address naming another.
  const { proposalId } = useParams();
  const navigate = useNavigate();
  const openId = proposalId && /^[0-9]{1,19}$/.test(proposalId) ? Number(proposalId) : null;
  const [proposals, setProposals] = useState<ProposalSummary[] | null>(null);
  const [nonce, setNonce] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** Set once a page came back short or empty: there is nothing older to offer. */
  const [exhausted, setExhausted] = useState(false);

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

  /**
   * Fetch the page before the oldest one on screen.
   *
   * `listProposals` has accepted `beforeId` since it was written and **no caller ever passed it**,
   * while the service caps a listing at `proposal_list_limit` (50). A PR gate is precisely the
   * surface that accumulates, so proposal 51 was not below a fold — it was never fetched, and
   * nothing said the list was short. A full page is the only evidence there might be more, which
   * is the same rule the service uses for its own session cursor.
   */
  const older = useCallback(() => {
    const oldest = proposals?.[proposals.length - 1]?.id;
    if (!oldest || loadingOlder) return;
    setLoadingOlder(true);
    void api
      .listProposals(auth, { state: 'pending', beforeId: oldest })
      .then((page) => {
        setProposals((current) => [...(current ?? []), ...page]);
        setExhausted(page.length === 0);
      })
      .catch(() => setExhausted(true))
      .finally(() => setLoadingOlder(false));
  }, [auth, loadingOlder, proposals]);

  // **The sheet is rendered whatever the list says.** It used to sit inside the "we have rows"
  // branch, which is fine while the only way to open one is to click a row — and wrong the moment a
  // URL can open one: `/review/7` for a proposal that is not on the pending page (already decided,
  // or older than this page) landed on the empty state with nothing open and no explanation.
  const sheet =
    openId !== null ? (
      <ProposalSheet
        id={openId}
        open
        onOpenChange={(next) => {
          if (next) return;
          // Closing is a navigation for the same reason opening is. `replace`, so Back from a
          // closed sheet returns to wherever the reader came from rather than reopening it.
          void navigate('/review', { replace: true });
        }}
        onDecided={reload}
      />
    ) : null;

  // **One returned tree, with the sheet at a fixed position.** This used to return three
  // structurally different fragments — loading, empty, list — each with `{sheet}` at a different
  // child index, so when a deep link opened the sheet while `proposals` was still `null` and the
  // listing then landed, React reconciled a *different* shape at that position and unmounted and
  // remounted `ProposalSheet`. Measured: the proposal was fetched twice for one open, and
  // `reason` — component state, and the rejection justification this queue requires — was wiped
  // between the chemist typing it and the list arriving. On a sign-off surface, silently.
  //
  // `JobsPanel` has always had this right, and the same probe against `/jobs/:jobId` reads the job
  // exactly once; this is that shape.
  return (
    <>
      {!proposals ? (
        <Loading>Reading the review queue…</Loading>
      ) : proposals.length === 0 ? (
        <EmptyState
          icon={<FileCheck2 className="size-5" />}
          title="No notes are waiting for review"
        >
          Everything the agent has proposed has been decided. A new proposal appears here the moment
          a turn opens one.
        </EmptyState>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {proposals.map((proposal) => (
              <li key={proposal.id}>
                <button
                  type="button"
                  // Navigating rather than setting state, so what is open is the URL and only
                  // the URL — see the note on `openId` above.
                  onClick={() => void navigate(`/review/${proposal.id}`)}
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
          {/* Only while a full page came back — the service caps the listing, and a short page is the
          evidence there is nothing older. Asking for one row beyond the ceiling to know for sure
          would cost every listing an extra row to answer a question the next request answers for
          free by coming back empty, which is the argument the service makes for its own cursor. */}
          {!exhausted && proposals.length >= PAGE_IS_FULL && (
            <div className="mt-2">
              <Button variant="ghost" size="sm" disabled={loadingOlder} onClick={older}>
                {loadingOlder ? 'Loading…' : 'Load older proposals'}
              </Button>
            </div>
          )}
        </>
      )}
      {sheet}
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

        <Digests />

        <section aria-labelledby="pending-heading">
          <h2 id="pending-heading" className="mb-1 text-lg font-semibold tracking-tight">
            Questions waiting on you
          </h2>
          <p className="mb-3 text-sm text-ink-muted">
            Work the agent has paused for an answer only a person can give — a measured yield, a
            value off an instrument. Until this section existed, one of these became a durable job
            that ran for seven days and then expired.
          </p>
          <PendingInbox />
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
