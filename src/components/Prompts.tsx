/**
 * The two interactive prompts a turn can raise.
 *
 * - `QuestionPrompt`: the agent asks the chemist to disambiguate; answered as the next message.
 * - `ApprovalPrompt`: a sign-off on the plan via `POST /sessions/{id}/plan/decision`, which records
 *   who approved which plan (hash-bound). A service without the plan route falls back to a
 *   confirmed prefilled message.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api } from '../api/client.ts';
import { PlanItems } from './PlanItems.tsx';
import { ApiError } from '../api/errors.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { useChatStore } from '../state/chatStore.ts';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/chem/ConfirmDialog';
import { Loading } from '@/components/chem/Feedback';
import { prefill, prefillAndSend } from '../state/composerEvents.ts';

export function QuestionPrompt({
  question,
  options,
}: {
  question: string;
  options: string[];
}): React.JSX.Element {
  return (
    <div className="mt-3 rounded-lg border border-brand/40 bg-brand-soft p-3.5">
      <p className="text-sm font-medium text-brand-ink">{question}</p>
      {options.length > 0 ? (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {options.map((option) => (
            <Button key={option} variant="outline" size="sm" onClick={() => prefill(option)}>
              {option}
            </Button>
          ))}
        </div>
      ) : (
        <p className="mt-1.5 text-xs text-ink-muted">Answer in the box below to continue.</p>
      )}
    </div>
  );
}

/** Yes/No controls plus whatever the decision produced, with their confirmation copy. */
function DecisionControls({
  state,
  error,
  onDecide,
  lockedReason = null,
}: {
  state: 'idle' | 'sending' | 'approved' | 'rejected' | 'failed';
  error: string | null;
  onDecide: (approved: boolean) => void;
  /**
   * Why this reader may not decide (in a shared conversation only the plan's author decides). The
   * buttons stay, disabled and described, so the card still reads as waiting on somebody.
   */
  lockedReason?: string | null;
}): React.JSX.Element {
  const reasonId = useId();
  if (state === 'rejected') {
    return <p className="text-sm text-ink-muted">You declined this plan. Nothing will run.</p>;
  }
  if (state === 'approved') {
    // Recording a decision runs nothing: the agent acts on the next request the chemist sends, and
    // an approval is spent when that turn ends.
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-ink-muted">
          Approved. This covers your <span className="font-medium text-ink">next request only</span>{' '}
          — the agent acts when you ask again, and the approval is spent when that turn ends.
        </p>
        {/* One click to continue, deliberately not auto-sent: the approval should not be spent on a turn nobody chose. */}
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => prefillAndSend('Go ahead with the approved plan.')}
          >
            Continue
          </Button>
        </div>
      </div>
    );
  }
  if (lockedReason) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="success" size="sm" disabled aria-describedby={reasonId}>
            Approve plan
          </Button>
          <Button variant="outline" size="sm" disabled aria-describedby={reasonId}>
            Decline
          </Button>
        </div>
        <p id={reasonId} className="text-xs text-ink-muted">
          {lockedReason}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Both decisions are confirmed: irreversible and attributable. */}
      <ConfirmDialog
        trigger={
          <Button variant="success" size="sm" disabled={state === 'sending'}>
            Approve plan
          </Button>
        }
        title="Approve plan?"
        description={
          <>
            This is recorded against your account and cannot be undone. The agent will act on it on
            its next run.
          </>
        }
        confirmLabel="Approve plan"
        variant="success"
        onConfirm={() => onDecide(true)}
      />
      <ConfirmDialog
        trigger={
          <Button variant="outline" size="sm" disabled={state === 'sending'}>
            Decline
          </Button>
        }
        title="Decline?"
        description="The agent will not proceed with what it proposed. This is recorded against your account."
        confirmLabel="Decline"
        onConfirm={() => onDecide(false)}
      />
      {state === 'sending' && <Loading size="xs">Recording your decision…</Loading>}
      {error && (
        <span role="alert" className="text-xs text-danger-ink">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * Who may decide a plan (the service's `plan_gate.may_decide`, restated only to decide what to
 * offer). `author`: a string is that person only; `null` means the session owner; `undefined` means
 * the plan streamed into this browser's own turn. Returns the refusal sentence, or `null`. An
 * unknown reader identity is let through; the service is the gate.
 */
export function planDecisionLock(
  author: string | null | undefined,
  me: string | null,
  member: { owner: string | null } | undefined,
): string | null {
  if (author === undefined || me === null) return null;
  if (author !== null) {
    return author === me
      ? null
      : `Only ${author} can approve or decline this plan — it was proposed in answer to their message, and in a shared conversation a plan is its author's alone to decide.`;
  }
  if (!member) return null;
  return member.owner
    ? `Only this conversation's owner, ${member.owner}, can decide on this plan.`
    : "Only this conversation's owner can decide on this plan.";
}

function PlanApprovalPrompt({
  sessionId,
  planTodos,
  planHash,
  planScope,
  planAuthor,
}: {
  sessionId: string | null;
  /** The plan this message rendered, from its own `plan` event. */
  planTodos?: string[] | null;
  /**
   * The identity of `planTodos` from the same event, preferred over a fetch so the decision binds
   * to what this card shows. Absent (older service): fetch.
   */
  planHash?: string | null;
  /**
   * The plan's declared state-changing tools from the same event, preferred over the fetch for the
   * same reason. Null (older service) falls back to the fetch; never `[]` as a stand-in for
   * unknown.
   */
  planScope?: string[] | null;
  /** Whose turn wrote the plan, when it was read rather than streamed — see `planDecisionLock`. */
  planAuthor?: string | null;
}): React.JSX.Element {
  const { auth } = useAuth();
  // Whether this is somebody else's conversation; the stored object keeps the selector stable.
  const membership = useChatStore((s) =>
    sessionId
      ? Object.values(s.conversations).find((c) => c.sessionId === sessionId)?.membership
      : undefined,
  );
  /** The author a read reported, stamped with the revision it describes — `fetchedScope`'s rule. */
  const [fetchedAuthor, setFetchedAuthor] = useState<{
    hash: string;
    author: string | null;
  } | null>(null);
  /** The service refused this reader's decision (403): whatever it said, the buttons stay locked. */
  const [refusal, setRefusal] = useState<string | null>(null);
  // The streamed plan, derived during render (a prop, not state).
  const streamedPlan = planHash && planTodos ? { hash: planHash, todos: planTodos } : null;
  const [fetchedPlan, setFetchedPlan] = useState<{ hash: string; todos: string[] } | null>(null);
  // The fetch wins when there is one, and there is one only after a 409 re-read — which is exactly
  // when the streamed plan is known to be stale.
  const plan = fetchedPlan ?? streamedPlan;
  // `unavailable`: no plan route (older service, or no session), so the composer fallback is used.
  const [state, setState] = useState<
    'loading' | 'idle' | 'sending' | 'approved' | 'rejected' | 'failed' | 'unavailable'
  >(streamedPlan ? 'idle' : sessionId ? 'loading' : 'unavailable');
  const [error, setError] = useState<string | null>(null);
  /**
   * The scope a read returned, stamped with the plan hash it describes, so it is only shown under
   * that revision.
   */
  const [fetchedScope, setFetchedScope] = useState<{
    hash: string;
    scope: string[] | null;
  } | null>(null);
  /**
   * The tools approving the displayed plan would authorize, or `null` when unknown (rendered as
   * nothing, never as an empty list). Derived during render.
   */
  const scope =
    plan && fetchedScope?.hash === plan.hash
      ? fetchedScope.scope
      : plan && planHash && plan.hash === planHash
        ? (planScope ?? null)
        : null;

  // Through a ref, so the read depends only on the session (`useAuth()` returns a new object each
  // render).
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  });
  // The provider, so a 401 recovers like other routes; stable across renders.
  const currentAuth = useMemo(
    () => ({
      getAccessToken: () => authRef.current.getAccessToken(),
      handleUnauthorized: () => authRef.current.handleUnauthorized(),
    }),
    [],
  );

  /**
   * A ticket per plan read, so an older read resolving late cannot overwrite a newer one (the mount
   * read and the 409 re-read race).
   */
  const readSeq = useRef(0);

  useEffect(() => {
    if (!sessionId) return;
    // With steps, hash and scope all streamed, this read does not run.
    const streamed = Boolean(planHash && planTodos);
    // Still needed for services that send no `scope`, and for the 409 re-read.
    if (streamed && planScope != null) return;
    let live = true;
    const seq = ++readSeq.current;
    const current = (): boolean => live && seq === readSeq.current;
    void (async () => {
      try {
        const status = await api.getPlan(sessionId, currentAuth);
        if (!current()) return;
        // Stamped with its revision; a missing scope stays `null` (unknown).
        setFetchedScope({ hash: status.plan_hash, scope: status.scope ?? null });
        if (status.author !== undefined) {
          setFetchedAuthor({ hash: status.plan_hash, author: status.author });
        }
        // The binding never comes from this read when the plan was streamed.
        if (streamed) return;
        setFetchedPlan({ hash: status.plan_hash, todos: status.plan });
        setState(status.approved ? 'approved' : 'idle');
      } catch {
        // On failure, fall back to the composer path unless the plan was streamed (then the card
        // stands without a scope).
        if (current() && !streamed) setState('unavailable');
      }
    })();
    return () => {
      live = false;
    };
  }, [sessionId, currentAuth, planHash, planTodos, planScope]);

  const decide = async (approved: boolean): Promise<void> => {
    if (!sessionId || !plan) return;
    setState('sending');
    setError(null);
    try {
      await api.decidePlan(sessionId, approved, plan.hash, currentAuth);
      setState(approved ? 'approved' : 'rejected');
      return;
    } catch (err) {
      // 403: the author rule. Final for this reader, so lock the card with the service's sentence.
      if (err instanceof ApiError && err.kind === 'forbidden') {
        setRefusal(err.message);
        setState('idle');
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not deliver the decision.');
      if (!(err instanceof ApiError && err.kind === 'plan_changed')) {
        setState('failed');
        return;
      }
    }
    // The plan moved: re-read it so the buttons bind to the current plan. Never retry the decision
    // with the new hash.
    const seq = ++readSeq.current;
    try {
      const status = await api.getPlan(sessionId, currentAuth);
      if (seq !== readSeq.current) return;
      setFetchedPlan({ hash: status.plan_hash, todos: status.plan });
      // The scope moves with the steps.
      setFetchedScope({ hash: status.plan_hash, scope: status.scope ?? null });
      if (status.author !== undefined) {
        setFetchedAuthor({ hash: status.plan_hash, author: status.author });
      }
      setState('idle');
    } catch {
      if (seq === readSeq.current) setState('failed');
    }
  };

  // The author a read reported for the revision on screen wins; otherwise what the message carried.
  const author = plan && fetchedAuthor?.hash === plan.hash ? fetchedAuthor.author : planAuthor;
  const me = auth.account?.id ?? null;

  if (state === 'loading') return <Loading size="xs">Reading the plan…</Loading>;

  if (state === 'unavailable') {
    return (
      <>
        <div className="flex flex-wrap gap-2">
          {/* The fallback posts a message, so it is confirmed too. */}
          <ConfirmDialog
            trigger={
              <Button variant="outline" size="sm">
                Approve
              </Button>
            }
            title="Approve in the conversation?"
            description="This service cannot record a plan decision, so your approval is sent as a message. It is not bound to a plan hash and is not recorded as a sign-off."
            confirmLabel="Send approval"
            onConfirm={() => prefillAndSend('Approved — go ahead.')}
          />
          <ConfirmDialog
            trigger={
              <Button variant="outline" size="sm">
                Decline
              </Button>
            }
            title="Decline in the conversation?"
            description="This is sent as a message telling the agent not to proceed."
            confirmLabel="Send decline"
            onConfirm={() => prefillAndSend('Do not proceed.')}
          />
        </div>
        <p className="mt-2 text-xs text-ink-muted">
          This service cannot record a plan decision, so this answers in the conversation instead.
        </p>
      </>
    );
  }

  return (
    <>
      {/* `PlanItems`, the one rendering of plan steps: it understands the `[x] `/`[ ] ` prefixes and the fetch fallback's plain shape. */}
      {plan && plan.todos.length > 0 && (
        <div className="mb-3">
          <PlanItems todos={plan.todos} />
        </div>
      )}
      {/* What the approval covers. An empty list (no tools declared) is stated plainly too. */}
      {scope !== null && (
        <p className="mb-3 text-xs text-warn-ink">
          Approving authorises{' '}
          {scope.length === 0 ? (
            'no tools beyond the read-only ones every turn has'
          ) : (
            <span className="font-mono">{scope.join(' · ')}</span>
          )}
          .
        </p>
      )}
      {typeof author === 'string' && (membership || author !== me) && (
        <p className="mb-3 text-xs text-ink-muted">
          Proposed in answer to{' '}
          {author === me ? (
            'your message'
          ) : (
            <>
              <span className="font-mono break-all">{author}</span>’s message
            </>
          )}
          .
        </p>
      )}
      <DecisionControls
        state={state}
        error={error}
        onDecide={(approved) => void decide(approved)}
        lockedReason={refusal ?? planDecisionLock(author, me, membership)}
      />
    </>
  );
}

/**
 * A plan approval, answered on the route that records it. The plan (and its hash) is taken when
 * the card appears, so the decision binds to what the human read; a 409 shows the new plan and
 * asks again, never approving whatever is current.
 */
export function ApprovalPrompt({
  prompt,
  sessionId,
  planTodos,
  planHash,
  planScope,
  planAuthor,
}: {
  prompt: string;
  /** The server session this conversation is bound to — the plan gate is per session, and
   *  `null` (no session yet) is what makes the composer fallback the only option. */
  sessionId: string | null;
  /** The plan this message rendered and its identity, so a decision binds to what was shown. */
  planTodos?: string[] | null;
  planHash?: string | null;
  /** And the tools it declares, which the card displays rather than merely collecting a yes to. */
  planScope?: string[] | null;
  /** Whose turn wrote the plan, when a read said — the one person who may decide on it. */
  planAuthor?: string | null;
}): React.JSX.Element {
  return (
    <div className="mt-3 rounded-lg border border-warn/40 bg-warn-soft p-3.5">
      <p className="mb-2.5 flex items-start gap-2 text-sm text-warn-ink">
        <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
        <span>
          <span className="font-semibold">Approval requested. </span>
          {prompt}
        </span>
      </p>
      <PlanApprovalPrompt
        sessionId={sessionId}
        planTodos={planTodos}
        planHash={planHash}
        planScope={planScope}
        planAuthor={planAuthor}
      />
    </div>
  );
}
