/**
 * The two interactive prompts a turn can raise.
 *
 * `QuestionPrompt` — the agent asking the chemist to disambiguate. Answered by sending the choice
 * as the next message, which is exactly what the backend expects.
 *
 * `ApprovalPrompt` — a human sign-off. Two genuinely different cases, and conflating them would
 * produce a button that silently does nothing:
 *   - `approval_id` present: a durable interaction hold, answered via POST /approvals/{id}/decision.
 *   - `approval_id` empty: a plan approval, answered via POST /sessions/{id}/plan/decision.
 *
 * That second case used to say "which has no endpoint at all" and sent a chat message saying
 * "Approved — go ahead." instead. It has had an endpoint for a while, and the difference is not
 * cosmetic: the real route records *who* approved *which* plan, bound by a hash, and is the only
 * path into execute mode. A sentence in the transcript records nothing and binds nothing — the
 * agent read it as text and decided for itself, which is precisely the GxP line the plan gate
 * exists to draw.
 *
 * The prefill fallback survives for a service that predates the route (its GET 404s), because
 * the alternative is a card whose only buttons do nothing.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api } from '../api/client.ts';
import { ApiError } from '../api/errors.ts';
import { useAuth } from '../auth/AuthContext.tsx';
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

/** Yes/No controls plus whatever the decision produced — the shape both branches below render. */
function DecisionControls({
  state,
  error,
  labels,
  onDecide,
}: {
  state: 'idle' | 'sending' | 'approved' | 'rejected' | 'failed';
  error: string | null;
  labels: [string, string];
  onDecide: (approved: boolean) => void;
}): React.JSX.Element {
  if (state === 'approved' || state === 'rejected') {
    return (
      <p className="text-sm text-ink-muted">
        You {state} this request. The agent will pick it up on its next run.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Both decisions are confirmed. This is the most consequential click in the product: it is
          irreversible, it is attributable, and it is the point of the gate. A single tap was one
          mis-aimed thumb away from approving work nobody read. */}
      <ConfirmDialog
        trigger={
          <Button variant="success" size="sm" disabled={state === 'sending'}>
            {labels[0]}
          </Button>
        }
        title={`${labels[0]}?`}
        description={
          <>
            This is recorded against your account and cannot be undone. The agent will act on it on
            its next run.
          </>
        }
        confirmLabel={labels[0]}
        variant="success"
        onConfirm={() => onDecide(true)}
      />
      <ConfirmDialog
        trigger={
          <Button variant="outline" size="sm" disabled={state === 'sending'}>
            {labels[1]}
          </Button>
        }
        title={`${labels[1]}?`}
        description="The agent will not proceed with what it proposed. This is recorded against your account."
        confirmLabel={labels[1]}
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
 * A plan approval, answered on the route that actually records it.
 *
 * The plan is fetched when the card appears rather than when a button is pressed, and that
 * ordering is the whole binding: the hash posted back is the hash of the plan the human read. A
 * plan that changed in between comes back 409, and the honest response is to show the new plan
 * and ask again — never to re-fetch the hash and approve whatever is current, which would make
 * the binding decorative.
 */
function PlanApprovalPrompt({
  sessionId,
  planTodos,
  planHash,
}: {
  sessionId: string | null;
  /** The plan this message rendered, from its own `plan` event. */
  planTodos?: string[] | null;
  /**
   * The identity of `planTodos`, as the same event stated it.
   *
   * Preferred over the fetch below, and that is the fix rather than an optimisation: the service
   * added `plan_hash` to the event precisely so a client would not have to ask again, because the
   * ask races the revision the hash exists to catch — between the render and the fetch the agent
   * may revise the plan, and the round trip answers with whatever is current rather than with what
   * this card is showing. Taking both from one event is what makes "the hash of the plan the human
   * read" literally true.
   *
   * Absent or empty for a service that predates the field, which falls back to the fetch — the
   * previous behaviour, kept for exactly that case.
   */
  planHash?: string | null;
}): React.JSX.Element {
  const { auth } = useAuth();
  // What the turn's own `plan` event carried, when it carried a hash. Derived during render rather
  // than copied into state by an effect: it is a prop, so storing it would be one more thing that
  // can disagree with its source, and the effect below then exists only for the fetch.
  const streamedPlan = planHash && planTodos ? { hash: planHash, todos: planTodos } : null;
  const [fetchedPlan, setFetchedPlan] = useState<{ hash: string; todos: string[] } | null>(null);
  // The fetch wins when there is one, and there is one only after a 409 re-read — which is exactly
  // when the streamed plan is known to be stale.
  const plan = fetchedPlan ?? streamedPlan;
  // `unavailable` is the older-service path: no plan route, so the composer fallback stands in.
  // Derived from the session at mount: with no session there is no plan route to read, and
  // flipping to 'unavailable' from inside the effect rendered a spinner for one frame first.
  const [state, setState] = useState<
    'loading' | 'idle' | 'sending' | 'approved' | 'rejected' | 'failed' | 'unavailable'
  >(streamedPlan ? 'idle' : sessionId ? 'loading' : 'unavailable');
  const [error, setError] = useState<string | null>(null);

  // Through a ref, so the read below depends on the session alone. `useAuth()` hands back a fresh
  // object on every render, and an effect that listed it as a dependency re-read the plan on each
  // state change — five GETs for one card, and each state update triggered another.
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  });
  // The *provider*, not just its token, so a 401 on the plan routes recovers like every other
  // route (`api/client.ts`'s `TokenGetter`). Still stable across renders — the ref is what keeps
  // the effect's dependency list to the session, which is the reason it exists.
  const currentAuth = useMemo(
    () => ({
      getAccessToken: () => authRef.current.getAccessToken(),
      handleUnauthorized: () => authRef.current.handleUnauthorized(),
    }),
    [],
  );

  useEffect(() => {
    if (!sessionId) return;
    // Nothing to read: the stream already said what the plan is and what its identity is, so this
    // card binds to what the message rendered and costs no round trip at all. The fetch is the
    // fallback for a service that sent no hash, not the normal path.
    if (planHash && planTodos) return;
    let live = true;
    void (async () => {
      try {
        const status = await api.getPlan(sessionId, currentAuth);
        if (!live) return;
        setFetchedPlan({ hash: status.plan_hash, todos: status.plan });
        setState(status.approved ? 'approved' : 'idle');
      } catch {
        // Any failure here — a service without the route, an expired token, an unreachable pod —
        // leaves the chemist with a card they can still act on rather than one that cannot be
        // answered at all.
        if (live) setState('unavailable');
      }
    })();
    return () => {
      live = false;
    };
  }, [sessionId, currentAuth, planHash, planTodos]);

  const decide = async (approved: boolean): Promise<void> => {
    if (!sessionId || !plan) return;
    setState('sending');
    setError(null);
    try {
      await api.decidePlan(sessionId, approved, plan.hash, currentAuth);
      setState(approved ? 'approved' : 'rejected');
      return;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not deliver the decision.');
      if (!(err instanceof ApiError && err.kind === 'plan_changed')) {
        setState('failed');
        return;
      }
    }
    // The plan moved between being shown and being answered. Re-read it, so the buttons bind to
    // what is actually being proposed — and never retry the decision with the new hash, which
    // would approve a plan nobody read.
    try {
      const status = await api.getPlan(sessionId, currentAuth);
      setFetchedPlan({ hash: status.plan_hash, todos: status.plan });
      setState('idle');
    } catch {
      setState('failed');
    }
  };

  if (state === 'loading') return <Loading size="xs">Reading the plan…</Loading>;

  if (state === 'unavailable') {
    return (
      <>
        <div className="flex flex-wrap gap-2">
          {/* This path posts a sentence into the conversation rather than recording a decision,
              so it needs the confirmation MORE than the real route, not less: it used to fire on
              a single tap and auto-send, removing the only review moment that existed. */}
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
      {plan && plan.todos.length > 0 && (
        <ul className="mb-3 space-y-1">
          {plan.todos.map((todo, i) => (
            <li key={i} className="flex gap-2 text-sm">
              <span
                aria-hidden
                className="mt-1.5 size-1.5 shrink-0 rounded-[1px] border border-ink-subtle"
              />
              <span>{todo}</span>
            </li>
          ))}
        </ul>
      )}
      <DecisionControls
        state={state}
        error={error}
        labels={['Approve plan', 'Decline']}
        onDecide={(approved) => void decide(approved)}
      />
    </>
  );
}

export function ApprovalPrompt({
  prompt,
  approvalId,
  sessionId,
  planTodos,
  planHash,
}: {
  prompt: string;
  approvalId: string;
  /** The server session this conversation is bound to — the plan gate is per session, and
   *  `null` (no session yet) is what makes the composer fallback the only option. */
  sessionId: string | null;
  /** The plan this message rendered and its identity, forwarded to the plan card so a decision
   *  binds to what was shown rather than to a second read that races it. */
  planTodos?: string[] | null;
  planHash?: string | null;
}): React.JSX.Element {
  const { auth } = useAuth();
  const [state, setState] = useState<'idle' | 'sending' | 'approved' | 'rejected' | 'failed'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);

  const decide = async (approved: boolean): Promise<void> => {
    setState('sending');
    setError(null);
    try {
      await api.decideApproval(approvalId, approved, auth);
      setState(approved ? 'approved' : 'rejected');
    } catch (err) {
      setState('failed');
      setError(err instanceof Error ? err.message : 'Could not deliver the decision.');
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-warn/40 bg-warn-soft p-3.5">
      <p className="mb-2.5 flex items-start gap-2 text-sm text-warn-ink">
        <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
        <span>
          <span className="font-semibold">Approval requested. </span>
          {prompt}
        </span>
      </p>

      {approvalId ? (
        <DecisionControls
          state={state}
          error={error}
          labels={['Approve', 'Reject']}
          onDecide={(approved) => void decide(approved)}
        />
      ) : (
        <PlanApprovalPrompt sessionId={sessionId} planTodos={planTodos} planHash={planHash} />
      )}
    </div>
  );
}
