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
    <div className="mt-3 rounded-md border border-brand/40 bg-brand-soft p-3">
      <p className="text-sm font-medium">{question}</p>
      {options.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => prefill(option)}
              className="rounded border border-brand/50 bg-surface-raised px-2 py-1 text-sm hover:brightness-95"
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
        className="rounded bg-ok px-3 py-1 text-sm font-medium text-ok-fg disabled:opacity-50"
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
      {error && <span className="text-xs text-danger-ink">{error}</span>}
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
  // `unavailable` is the older-service path: no plan route, so the composer fallback stands in.
  const [state, setState] = useState<
    'loading' | 'idle' | 'sending' | 'approved' | 'rejected' | 'failed' | 'unavailable'
  >('loading');
  const [error, setError] = useState<string | null>(null);

  // Through a ref, so the read below depends on the session alone. `useAuth()` hands back a fresh
  // object on every render, and an effect that listed it as a dependency re-read the plan on each
  // state change — five GETs for one card, and each state update triggered another.
  const authRef = useRef(auth);
  authRef.current = auth;
  const token = useCallback((): Promise<string | null> => authRef.current.getAccessToken(), []);

  useEffect(() => {
    if (!sessionId) {
      setState('unavailable');
      return;
    }
    let live = true;
    void (async () => {
      try {
        const status = await api.getPlan(sessionId, token);
        if (!live) return;
        setPlan({ hash: status.plan_hash, todos: status.plan });
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
  }, [sessionId, token]);

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

  if (state === 'loading') return <p className="text-xs text-ink-muted">Reading the plan…</p>;

  if (state === 'unavailable') {
    return (
      <>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => prefillAndSend('Approved — go ahead.')}
            className="rounded border border-border-subtle bg-surface-raised px-3 py-1 text-sm"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => prefillAndSend('Do not proceed.')}
            className="rounded border border-border-subtle bg-surface-raised px-3 py-1 text-sm"
          >
            Decline
          </button>
        </div>
        <p className="mt-1.5 text-xs text-ink-muted">
          This service cannot record a plan decision, so this answers in the conversation instead.
        </p>
      </>
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
