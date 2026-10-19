/**
 * What is waiting on a human, across every conversation: undecided plans, held-open questions,
 * behaviour proposals, and the reader's own check-ins.
 *
 * Plans (`GET /plans/pending`): under `plan_only` autonomy a state-changing step waits for a human
 * to approve the exact plan shown, and the decision card otherwise lives only inside the turn. They
 * are not decided here — the plan is approved beside the reasoning in its conversation.
 *
 * An empty list is never shown as "you are up to date" on its own: each section says which
 * emptiness it is (no gate, nothing waiting, a partial scan), and a failed call says it failed.
 */

import { useEffect, useMemo, useState } from 'react';
import { Clock, Inbox, ListChecks } from 'lucide-react';
import { Link } from 'react-router';
import { keepPreviousData } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext.tsx';
import { keys, useApiQuery } from '../api/queryClient.ts';
import { pendingPlansQuery, sharedSessionsQuery } from '../api/queries.ts';
import {
  api,
  type PendingPlan,
  type PendingRequest,
  type PendingPlans as PendingPlansView,
  type SharedSessionSummary,
} from '../api/client.ts';
import { ApiError } from '../api/errors.ts';
import { relativeTime } from '../lib/format.ts';
import { checkInKey, useChatStore } from '../state/chatStore.ts';
import { BehaviourProposals } from './BehaviourProposals.tsx';
import { adoptShared } from './Sidebar.tsx';
import { CitationChip } from './CitationChip.tsx';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/chem/ConfirmDialog';
import { EmptyState, Loading } from '@/components/chem/Feedback';

/** Turn a service timestamp into "3 hours ago", or nothing when there is none to turn. */
function when(value: string | null): string {
  if (!value) return '';
  const at = new Date(value).getTime();
  return Number.isNaN(at) ? '' : relativeTime(at);
}

/** Why the plan list is empty: three different emptinesses, only one of which means up to date. */
function NoPlansWaiting({ view }: { view: PendingPlansView }): React.JSX.Element {
  if (view.considered === 0) {
    return (
      <EmptyState icon={<ListChecks className="size-5" />} title="No conversations to check">
        This service holds no conversation of yours, and none has been shared with you yet. A plan
        can only wait on you once the agent has proposed one.
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
 * How much of the answer is missing: `unread` counts gated conversations whose plan was not read;
 * `truncated` means the scan stopped early (no count — conversations beyond it may not be gated at
 * all).
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
 * The conversation a pending plan sits in, as `adoptShared` takes it, or `undefined` when it is
 * this person's own. Built from `PendingPlan.owner`; falls back to the shared listing for older
 * services or when the reader's id is unknown.
 */
export function sharedConversationOf(
  pending: PendingPlan,
  listed: SharedSessionSummary | undefined,
  me: string | null | undefined,
): SharedSessionSummary | undefined {
  if (pending.owner === undefined || !me) return listed;
  if (pending.owner === me) return undefined;
  return (
    listed ?? {
      session_id: pending.session_id,
      owner: pending.owner,
      title: pending.title,
      // Its last activity, used only to order the adopted conversation.
      added_at: pending.updated_at,
    }
  );
}

/** Undecided plans in every conversation. A failure is shown, not folded into an empty list. */
function PlanInbox(): React.JSX.Element {
  const { auth, ready } = useAuth();
  // `staleTime` bounds rescans of the most expensive route; `decidePlan` invalidates the key (see
  // `PENDING_PLANS_STALE_MS`).
  const {
    data: view = null,
    isError: failed,
    isPending,
  } = useApiQuery({ ...pendingPlansQuery(auth), enabled: ready });
  // Plans can sit in conversations this person does not own. The shared listing (a cache hit, same
  // key as the sidebar) is the fallback for services without `owner`.
  const { data: shared } = useApiQuery<SharedSessionSummary[], ApiError>({
    ...sharedSessionsQuery(auth),
    enabled: ready,
  });
  // A malformed shared listing reads as nothing shared rather than hiding the plans.
  const sharedBySession = useMemo(
    () =>
      new Map((Array.isArray(shared) ? shared : []).map((row) => [row.session_id, row] as const)),
    [shared],
  );

  // An error stays shown during a background refetch; checked before `isPending` (true while
  // disabled).
  if (failed) {
    return (
      <p role="alert" className="text-sm text-danger-ink">
        The service could not be asked which plans are waiting. This is not the same as nothing
        waiting — a plan already approved still executes, and one that is not still blocks.
      </p>
    );
  }
  if (!view || isPending) return <Loading>Reading the plan gate…</Loading>;
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
        {view.plans.map((pending) => {
          const sharedRow = sharedConversationOf(
            pending,
            sharedBySession.get(pending.session_id),
            auth.account?.id,
          );
          return (
            <li
              key={pending.session_id}
              className="rounded-lg border border-warn/40 bg-surface-raised p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{pending.title ?? 'Untitled conversation'}</span>
                <Badge tone="warn">
                  {pending.plan.length} {pending.plan.length === 1 ? 'step' : 'steps'}
                </Badge>
                {sharedRow && (
                  // Whose conversation, because opening it lands in somebody else's thread — and
                  // the plan is still this person's: only its author may decide it.
                  <Badge>
                    {sharedRow.owner ? `Shared by ${sharedRow.owner}` : 'Shared with you'}
                  </Badge>
                )}
                <span className="text-2xs text-ink-subtle">
                  last active {when(pending.updated_at)}
                </span>
              </div>
              {/* The steps themselves: what is being approved is the work. */}
              <ol className="mt-2 flex list-decimal flex-col gap-1 pl-5 text-sm text-ink-muted">
                {pending.plan.map((step, index) => (
                  <li key={`${index}-${step}`}>{step}</li>
                ))}
              </ol>
              {/* What deciding it would authorise, so the reader can pick which plan to open. Absent from older services. */}
              {pending.scope && pending.scope.length > 0 && (
                <p className="mt-2 text-xs text-ink-muted">
                  Approving authorises{' '}
                  <span className="font-mono">{pending.scope.join(' · ')}</span>.
                </p>
              )}
              <div className="mt-3">
                <Button asChild size="sm" variant="outline">
                  {/* `/open/:sessionId` adopts the session locally; the decision is made there, beside its reasoning. */}
                  <Link
                    to={`/open/${pending.session_id}`}
                    // A shared conversation is adopted as shared first, so it opens with a member's
                    // rules.
                    onClick={sharedRow ? () => adoptShared([sharedRow]) : undefined}
                  >
                    Open the conversation to decide
                  </Link>
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <PartialScan view={view} />
    </div>
  );
}

/**
 * Standing-query findings. Claimed once at app start into the persisted store (the read consumes
 * them); this renders what was claimed. Dismissal is a flag, since this is the only copy.
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
        {visible.map(({ digest, index }) => {
          // Defaulted here rather than at every use: both are absent from cards claimed before
          // this build read them, and an absent one means the same as an empty one.
          const disputed = digest.disputed ?? [];
          const headlines = digest.headlines ?? {};
          return (
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
                    {/* Only when the service reported one: "0 of 2 disagree" would be a claim
                        about a corpus nobody consulted. The wording is the service's own. */}
                    {disputed.length > 0 &&
                      ` · ${disputed.length} of ${digest.noteIds.length} disagree with something already in the graph`}
                  </p>
                </div>
                <Button size="xs" variant="ghost" onClick={() => dismiss(index)}>
                  Dismiss
                </Button>
              </div>
              {/* One line per note (`headlines`), with disputed notes marked as well as counted. */}
              <ul className="mt-2 flex flex-col gap-1.5">
                {digest.noteIds.map((noteId) => (
                  <li key={noteId} className="flex flex-wrap items-baseline gap-1.5 text-sm">
                    <CitationChip kind="note" id={noteId} />
                    {disputed.includes(noteId) && <Badge tone="warn">disputed</Badge>}
                    {headlines[noteId] && (
                      <span className="min-w-0 text-ink-muted">{headlines[noteId]}</span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * What the page of waiting questions is, in the service's own sentence (it accounts for rows not
 * reached and rows the caller may not answer). Shown above the list, including over the empty
 * state. Empty from older services.
 */
function PageVerdict({ verdict }: { verdict: string }): React.JSX.Element | null {
  if (!verdict) return null;
  return (
    <p
      role="status"
      className="rounded-lg border border-border-subtle bg-surface-sunken px-3 py-2 text-xs text-ink-muted"
    >
      {verdict}
    </p>
  );
}

/**
 * Questions a workflow is holding open (`GET /pending`): from `request_external_input`, a BO
 * campaign waiting for measured yields, or a connector job. A failure is surfaced, not shown as
 * empty. A campaign yield is answered as a number; anything else as text, since the payload schema
 * is the workflow's.
 */
function PendingInbox(): React.JSX.Element {
  const { auth, ready } = useAuth();
  const [answering, setAnswering] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  /**
   * Questions this view saw settled (answered here, or 409 because someone else did), hidden while
   * `keepPreviousData` still shows the previous list. The service remains the authority.
   */
  const [settled, setSettled] = useState<ReadonlySet<string>>(() => new Set());
  const settle = (id: string): void => setSettled((held) => new Set(held).add(id));
  // The stream's own revision, not the list's length: `syncAwaiting` below must not be able to
  // re-trigger the read that calls it. See `awaitingRevision` in the store.
  const pushes = useChatStore((s) => s.awaitingRevision);

  // `nonce` and `pushes` are part of the key, so a push-back frame refetches without polling.
  // `keepPreviousData` keeps the list (and any answer being typed) on screen while a new key loads.
  const { data: view = null, isError: failed } = useApiQuery({
    queryKey: keys.pendingRequests(nonce, pushes),
    queryFn: () => api.listPendingRequests(auth),
    enabled: ready,
    placeholderData: keepPreviousData,
  });

  // Reconcile the store with the authoritative list after each answer; keeps the sidebar badge
  // honest across tabs.
  const waiting = useMemo(
    () => (view?.requests ?? []).filter((r) => r.state === 'waiting' && !settled.has(r.request_id)),
    [view, settled],
  );
  useEffect(() => {
    if (!view) return;
    useChatStore.getState().syncAwaiting(waiting.map((r) => r.request_id));
  }, [view, waiting]);

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
      settle(request.request_id);
      setAnswering(null);
      setValue('');
      setNotice('Answered. Whatever was waiting on it has been released.');
      setNonce((n) => n + 1);
    } catch (err: unknown) {
      // The 409 is the one worth spelling out: two chemists at one bench answering the same
      // question is ordinary, and the second must be told rather than have their answer dropped.
      if (err instanceof ApiError && err.status === 409) settle(request.request_id);
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

  // Rendered in both branches: answering the last open question empties the list, and the notice
  // saying what became of that answer is the one thing the reader still needs to see.
  const status = notice && (
    <p
      role="status"
      className="rounded-lg border border-border-subtle bg-surface-sunken px-3 py-2 text-xs"
    >
      {notice}
    </p>
  );
  if (waiting.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <PageVerdict verdict={view.verdict} />
        {status}
        <EmptyState icon={<Inbox className="size-5" />} title="Nothing is waiting on you">
          A question appears here when the agent holds work open for an answer only a person can
          give — a measured yield, a decision about a batch, a value off an instrument.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <PageVerdict verdict={view.verdict} />
      {status}
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
                    // Focus moves into the form because the reader clicked Answer (via a ref, not
                    // `autoFocus`).
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
                    <Link to={`/open/${request.session_id}`}>Open the conversation</Link>
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

/**
 * The caller's own questions still blocked on somebody else (check-ins): nothing to answer here;
 * the action is to go and ask. Claimed once at app start (the read consumes), so this renders what
 * was claimed; dismissal is a flag. `checkInClaim` distinguishes "nothing blocked" from a failed or
 * absent claim.
 */
function CheckIns(): React.JSX.Element {
  const cards = useChatStore((s) => s.checkIns);
  const claim = useChatStore((s) => s.checkInClaim);
  const dismiss = useChatStore((s) => s.dismissCheckIn);
  const visible = cards.filter((card) => !card.dismissed);

  // Reported even when there are cards, because those came from an earlier page and say nothing
  // about whether something has been added since.
  const failure =
    claim === 'failed' ? (
      <p role="alert" className="text-sm text-danger-ink">
        The service could not be asked what your work is waiting on. This is not the same as nothing
        waiting — a question nobody answers expires on its own, and the notice that it did is the
        only other one you get.
      </p>
    ) : null;

  if (visible.length === 0) {
    if (failure) return failure;
    // Only 'pending' is genuinely in flight: the claim runs once at the top of the app, so a
    // reader who navigated here later sees this for as long as that one request takes.
    if (claim === 'pending') return <Loading>Reading what you are waiting on…</Loading>;
    // A 404 means this deployment has no mailbox — not "nothing of yours is blocked".
    if (claim === 'absent') {
      return (
        <EmptyState icon={<Clock className="size-5" />} title="No check-in mailbox here">
          This deployment&apos;s service does not serve the check-in mailbox, so nothing can be said
          about what your work is waiting on — which is not the same as nothing waiting on it.
        </EmptyState>
      );
    }
    return (
      <EmptyState icon={<Clock className="size-5" />} title="Nothing of yours is blocked">
        A question you asked that somebody else has to answer appears here while it is still open —
        with how long it has been waiting, and how long is left before it expires.
      </EmptyState>
    );
  }

  // `=== true`: older cards carry `undefined`. The flag describes the notice, so any card carries
  // it.
  const short = visible.some((card) => card.truncated === true);

  return (
    <div className="flex flex-col gap-3">
      {failure}
      {short && (
        <p role="status" className="text-xs text-ink-muted">
          You have more questions waiting than one check-in carries, so this list may be short. Open
          your requests to see the rest.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {visible.map((card) => (
          <li
            key={checkInKey(card)}
            className="rounded-lg border border-border-subtle bg-surface-raised p-3"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {card.subject || 'A question with no subject'}
                  </span>
                  {/* The same badge the pending inbox draws. */}
                  {card.kind && <Badge tone="warn">{card.kind}</Badge>}
                  {/* Tone by urgency. `days_left` is floored upstream, so 0 means under a day, not expired. */}
                  <Badge tone={card.daysLeft <= 1 ? 'danger' : 'warn'}>
                    {card.daysLeft === 0
                      ? 'less than a day left'
                      : `${card.daysLeft} ${card.daysLeft === 1 ? 'day' : 'days'} left`}
                  </Badge>
                </div>
                <p className="mt-0.5 text-2xs text-ink-subtle">
                  waiting on {card.askedOf || 'anyone'} · open {card.openDays}{' '}
                  {card.openDays === 1 ? 'day' : 'days'} · claimed {relativeTime(card.receivedAt)}
                </p>
              </div>
              <Button size="xs" variant="ghost" onClick={() => dismiss(checkInKey(card))}>
                Dismiss
              </Button>
            </div>
            {/* The requester's words as sent; the service already notes its own truncation. */}
            {card.rationale && <p className="mt-1.5 text-sm text-ink-muted">{card.rationale}</p>}
            {/* Link to the conversation, when there is one (plate runs and connector jobs have none). */}
            {card.sessionId && (
              <div className="mt-2">
                <Button asChild size="sm" variant="ghost">
                  <Link to={`/open/${card.sessionId}`}>Open the conversation</Link>
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ReviewQueue(): React.JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        {/* First, because it is the section that blocks work: a question waits, a plan stops. */}
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

        {/* Proposals can be decided here: the service returns the whole document, so nothing is approved unseen. */}
        <section aria-labelledby="proposals-heading">
          <h2 id="proposals-heading" className="mb-1 text-lg font-semibold tracking-tight">
            Skills the agent has proposed
          </h2>
          <p className="mb-3 text-sm text-ink-muted">
            Procedures a turn worked out and thinks are worth keeping. Nothing it proposes acts on
            anything until you accept it, and what you accept acts on your turns alone —{' '}
            <Link className="underline" to="/skills">
              the skills screen
            </Link>{' '}
            is where you see and remove what is acting.
          </p>
          <BehaviourProposals />
        </section>

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

        {/* Last: work stopped somewhere else, a nudge rather than a decision. */}
        <section aria-labelledby="check-ins-heading">
          <h2 id="check-ins-heading" className="mb-1 text-lg font-semibold tracking-tight">
            Your work waiting on somebody else
          </h2>
          <p className="mb-3 text-sm text-ink-muted">
            Questions you asked that are still open, with how long is left before they expire. The
            service tells you once more when one runs out — and until this section existed, that was
            the only thing it ever told you.
          </p>
          <CheckIns />
        </section>
      </div>
    </div>
  );
}
