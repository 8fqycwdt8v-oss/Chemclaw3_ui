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
import { ShieldCheck } from 'lucide-react';
import { api } from '../api/client.ts';
import { ApiError } from '../api/errors.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/chem/ConfirmDialog';
import { Loading } from '@/components/chem/Feedback';

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
function PlanApprovalPrompt({ sessionId }: { sessionId: string | null }): React.JSX.Element {
  const { auth, ready } = useAuth();
  const [plan, setPlan] = useState<{ hash: string; todos: string[] } | null>(null);
  // `unavailable` is the older-service path: no plan route, so the composer fallback stands in.
  // Derived from the session at mount: with no session there is no plan route to read, and
  // flipping to 'unavailable' from inside the effect rendered a spinner for one frame first.
  const [state, setState] = useState<
    | 'loading'
    | 'idle'
    | 'sending'
    | 'approved'
    | 'rejected'
    | 'failed'
    | 'unavailable'
    // The plan route exists but could not be read right now. Distinct from `unavailable`, which
    // asserts the route is absent and stands the unbound fallback up in its place.
    | 'unreadable'
  >(sessionId ? 'loading' : 'unavailable');
  const [error, setError] = useState<string | null>(null);
  const [readNonce, setReadNonce] = useState(0);

  // Through a ref, so the read below depends on the session alone. `useAuth()` hands back a fresh
  // object on every render, and an effect that listed it as a dependency re-read the plan on each
  // state change — five GETs for one card, and each state update triggered another.
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  });
  const token = useCallback((): Promise<string | null> => authRef.current.getAccessToken(), []);

  useEffect(() => {
    if (!sessionId) return;
    // Wait for auth, like every other token-requiring read. Before this gate the card fetched on
    // mount against the placeholder provider, whose `getAccessToken` throws by design — the catch
    // below read that as "this service has no plan route" and dropped a *hash-bound, attributable*
    // sign-off to the unbound conversational fallback, permanently, on every page load that
    // rendered the card in the first commit.
    if (!ready) return;
    let live = true;
    void (async () => {
      try {
        const status = await api.getPlan(sessionId, token);
        if (!live) return;
        setPlan({ hash: status.plan_hash, todos: status.plan });
        setState(status.approved ? 'approved' : 'idle');
      } catch (err) {
        if (!live) return;
        // Only a genuinely absent route means "older service". Anything else — an expired token,
        // a 500, an unreachable pod — is transient, and answering it with the unbound fallback
        // would trade an attributable decision for an unattributable one over a blip.
        // A 404 is the older-service signal: no plan route, so the composer fallback stands in.
        // `errorFromStatus` kinds every 404 as `session_not_found`, which covers both "no such
        // route" and "dead session"; either way there is no plan here to bind a decision to.
        const absent = err instanceof ApiError && err.kind === 'session_not_found';
        setState(absent ? 'unavailable' : 'unreadable');
        setError(
          absent
            ? null
            : err instanceof Error
              ? err.message
              : 'Could not read the plan awaiting a decision.',
        );
      }
    })();
    return () => {
      live = false;
    };
  }, [sessionId, token, ready, readNonce]);

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

  if (state === 'loading') return <Loading size="xs">Reading the plan…</Loading>;

  if (state === 'unreadable') {
    // Deliberately offers no way to approve. The decision this card exists to record is bound to
    // a plan hash we do not currently have, and answering in the conversation instead would
    // convert an attributable sign-off into an unattributable one over what may be a blip.
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-ink-muted">
          {error ?? 'Could not read the plan awaiting a decision.'}
        </p>
        <Button
          variant="outline"
          size="xs"
          onClick={() => {
            setError(null);
            setState('loading');
            setReadNonce((n) => n + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

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
        <PlanApprovalPrompt sessionId={sessionId} />
      )}
    </div>
  );
}
