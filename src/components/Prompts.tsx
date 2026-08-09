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
 * the alternative is a card whose only buttons do nothing. It is reached from a 404 and from
 * nothing else — see `PlanApprovalPrompt`, where the distinction is the entire point.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import { ApiError } from '../api/errors.ts';
import { useAuth } from '../auth/AuthContext.tsx';

const prefill = (text: string): void => {
  window.dispatchEvent(new CustomEvent('chemclaw:prefill', { detail: text }));
};

/** Prefill the composer AND immediately submit — used for one-tap approval. */
const prefillAndSend = (text: string): void => {
  window.dispatchEvent(new CustomEvent('chemclaw:prefill', { detail: { text, autoSend: true } }));
};

export function QuestionPrompt({
  question,
  options,
}: {
  question: string;
  options: string[];
}): React.JSX.Element {
  return (
    <div className="mt-3 rounded-md border border-accent/40 bg-accent-soft p-3">
      <p className="text-sm font-medium">{question}</p>
      {options.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => prefill(option)}
              className="rounded border border-accent/50 bg-surface-raised px-2 py-1 text-sm hover:brightness-95"
            >
              {option}
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-xs text-ink-muted">Answer in the box below to continue.</p>
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
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={state === 'sending'}
        onClick={() => onDecide(true)}
        className="rounded bg-ok px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
      >
        {labels[0]}
      </button>
      <button
        type="button"
        disabled={state === 'sending'}
        onClick={() => onDecide(false)}
        className="rounded border border-border-subtle px-3 py-1 text-sm disabled:opacity-50"
      >
        {labels[1]}
      </button>
      {error && <span className="text-xs text-danger">{error}</span>}
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
function PlanApprovalPrompt({ sessionId }: { sessionId: string | null }): React.JSX.Element {
  const { auth } = useAuth();
  const [plan, setPlan] = useState<{ hash: string; todos: string[] } | null>(null);
  // `unavailable` is the older-service path and NOTHING else: no plan route, so the composer
  // fallback stands in. `unreadable` is every other failure — see the effect below.
  const [state, setState] = useState<
    | 'loading'
    | 'idle'
    | 'sending'
    | 'approved'
    | 'rejected'
    | 'failed'
    | 'unavailable'
    | 'unreadable'
  >('loading');
  const [error, setError] = useState<string | null>(null);
  /** Set when the chemist has explicitly accepted the unrecorded path. See `unavailable` below. */
  const [acceptedUnrecorded, setAcceptedUnrecorded] = useState(false);
  /** Bumped to re-run the read after a failure the user chose to retry. */
  const [attempt, setAttempt] = useState(0);

  // Through a ref, so the read below depends on the session alone. `useAuth()` hands back a fresh
  // object on every render, and an effect that listed it as a dependency re-read the plan on each
  // state change — five GETs for one card, and each state update triggered another.
  const authRef = useRef(auth);
  // In an effect rather than during render — see the same change in `Composer.tsx`. The read below
  // happens inside an async callback after commit, so it always sees the current value.
  useEffect(() => {
    authRef.current = auth;
  });
  const token = useCallback((): Promise<string | null> => authRef.current.getAccessToken(), []);

  useEffect(() => {
    // No session means there is nothing to read a plan from, which is a *derived* fact rather
    // than a fetch outcome — so it is computed below at `effectiveState` instead of being written
    // into state from inside this effect. Writing it here scheduled an extra render pass on every
    // mount of a card that has no session yet, which is the common case.
    if (!sessionId) return;
    let live = true;
    void (async () => {
      try {
        const status = await api.getPlan(sessionId, token);
        if (!live) return;
        setPlan({ hash: status.plan_hash, todos: status.plan });
        setState(status.approved ? 'approved' : 'idle');
      } catch (err) {
        if (!live) return;
        // This branch used to swallow EVERY failure into `unavailable`, whose fallback lets one
        // tap send "Approved — go ahead." with no `plan_approvals` row behind it. So an expired
        // token, a restarting pod or a network blip silently downgraded a GxP gate to an
        // unaudited path — and looked identical to the ordinary Approve/Decline pair while doing
        // it. That is the single worst failure mode in this component.
        //
        // Only a 404 means what the fallback was written for: a service whose route table does
        // not contain the plan endpoint. `errorFromStatus` maps 404 to `session_not_found`, and
        // the BFF's own route whitelist answers 404 the same way for a path it does not proxy.
        // (A dead session lands here too, which is fine — a session with no plan and a service
        // with no plan route are equally unanswerable on that route.)
        const noSuchRoute = err instanceof ApiError && err.kind === 'session_not_found';
        setError(err instanceof Error ? err.message : 'Could not read the plan.');
        setState(noSuchRoute ? 'unavailable' : 'unreadable');
      }
    })();
    return () => {
      live = false;
    };
  }, [sessionId, token, attempt]);

  const decide = async (approved: boolean): Promise<void> => {
    if (!sessionId || !plan) return;
    setState('sending');
    setError(null);
    try {
      await api.decidePlan(sessionId, approved, plan.hash, token);
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
      const status = await api.getPlan(sessionId, token);
      setPlan({ hash: status.plan_hash, todos: status.plan });
      setState('idle');
    } catch {
      setState('failed');
    }
  };

  // A card with no session can never resolve a plan, so it is `unavailable` by construction —
  // derived here rather than written into state by the effect above.
  const effectiveState = sessionId ? state : 'unavailable';

  if (effectiveState === 'loading') {
    return <p className="text-xs text-ink-muted">Reading the plan…</p>;
  }

  /**
   * The plan could not be read, and we do not know that the route is missing.
   *
   * No fallback is offered here, deliberately. The unrecorded path is only defensible when the
   * service genuinely cannot record a decision; offering it for a token that expired thirty
   * seconds ago would turn a transient failure into a permanent hole in the audit trail, and the
   * chemist would have no way to tell which they were looking at.
   */
  if (effectiveState === 'unreadable') {
    return (
      <div role="alert" className="rounded border border-danger/40 bg-danger-soft p-2">
        <p className="text-sm text-danger">
          <span className="font-semibold">
            The plan could not be read, so it cannot be approved.{' '}
          </span>
          {error}
        </p>
        <p className="mt-1 text-xs text-ink-muted">
          This is a failure to reach the plan gate, not a service without one — so there is no
          unrecorded shortcut on offer. Sign in again if your session has expired, then retry.
        </p>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setState('loading');
            setAttempt((n) => n + 1);
          }}
          className="mt-2 rounded border border-danger/40 px-2 py-0.5 text-xs text-danger"
        >
          Try again
        </button>
      </div>
    );
  }

  /**
   * The service has no plan route, so a decision here cannot be recorded anywhere.
   *
   * Gated behind an explicit acknowledgement, and rendered as degraded rather than as an ordinary
   * Approve/Decline pair. What the fallback actually does is send a sentence into the transcript
   * that the agent then reads as text and interprets for itself — no `plan_approvals` row, no
   * plan hash, nothing recording who approved what. Presenting that as an equivalent button is
   * the thing that makes it dangerous; presenting it as a documented downgrade is what makes it
   * survivable.
   */
  if (effectiveState === 'unavailable') {
    if (!acceptedUnrecorded) {
      return (
        <div className="rounded border border-warn/50 bg-surface-raised p-2">
          <p className="text-sm">
            <span className="font-semibold">This service cannot record a plan decision. </span>
            Approving or declining here sends a sentence into the conversation instead. The agent
            reads it as text and decides for itself — no approval is written, so nothing in the
            audit trail will show who agreed to what.
          </p>
          <button
            type="button"
            onClick={() => setAcceptedUnrecorded(true)}
            className="mt-2 rounded border border-warn/60 px-2.5 py-1 text-xs font-medium"
          >
            Answer in the conversation anyway
          </button>
        </div>
      );
    }
    return (
      <div className="rounded border border-dashed border-warn/60 p-2">
        <p className="mb-2 text-xs font-medium text-warn">Unrecorded — answered as a message</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => prefillAndSend('Approved — go ahead.')}
            className="rounded border border-border-subtle bg-surface-raised px-3 py-1 text-sm"
          >
            Approve (not recorded)
          </button>
          <button
            type="button"
            onClick={() => prefillAndSend('Do not proceed.')}
            className="rounded border border-border-subtle bg-surface-raised px-3 py-1 text-sm"
          >
            Decline (not recorded)
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {plan && plan.todos.length > 0 && (
        <ul className="mb-2 space-y-0.5">
          {plan.todos.map((todo, i) => (
            <li key={i} className="text-sm">
              <span className="mr-1.5 text-ink-muted">▢</span>
              {todo}
            </li>
          ))}
        </ul>
      )}
      <DecisionControls
        state={effectiveState}
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
}: {
  prompt: string;
  approvalId: string;
  /** The server session this conversation is bound to — the plan gate is per session, and
   *  `null` (no session yet) is what makes the composer fallback the only option. */
  sessionId: string | null;
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
      await api.decideApproval(approvalId, approved, () => auth.getAccessToken());
      setState(approved ? 'approved' : 'rejected');
    } catch (err) {
      setState('failed');
      setError(err instanceof Error ? err.message : 'Could not deliver the decision.');
    }
  };

  return (
    <div className="mt-3 rounded-md border border-warn/40 bg-warn-soft p-3">
      <p className="mb-2 text-sm">
        <span className="font-semibold">Approval requested. </span>
        {prompt}
      </p>

      {approvalId ? (
        <DecisionControls
          state={state}
          error={error}
          labels={['Approve', 'Reject']}
          onDecide={(approved) => void decide(approved)}
        />
      ) : (
        <PlanApprovalPrompt sessionId={sessionId} />
      )}
    </div>
  );
}
