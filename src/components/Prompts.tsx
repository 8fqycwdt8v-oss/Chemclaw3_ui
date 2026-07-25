/**
 * The two interactive prompts a turn can raise.
 *
 * `QuestionPrompt` — the agent asking the chemist to disambiguate. Answered by sending the choice
 * as the next message, which is exactly what the backend expects.
 *
 * `ApprovalPrompt` — a human sign-off. Two genuinely different cases, and conflating them would
 * produce a button that silently does nothing:
 *   - `approval_id` present: a durable interaction hold, answerable via POST /approvals/{id}/decision.
 *   - `approval_id` empty: a plan-approval prompt, which has no endpoint at all. The only channel
 *     back is the next chat message, so the buttons prefill the composer and the card says so.
 */

import { useState } from 'react';
import { api } from '../api/client.ts';
import { useAuth } from '../auth/AuthContext.tsx';

const prefill = (text: string): void => {
  window.dispatchEvent(new CustomEvent('chemclaw:prefill', { detail: text }));
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

export function ApprovalPrompt({
  prompt,
  approvalId,
}: {
  prompt: string;
  approvalId: string;
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
        state === 'approved' || state === 'rejected' ? (
          <p className="text-sm text-ink-muted">
            You {state} this request. The agent will pick it up on its next run.
          </p>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={state === 'sending'}
              onClick={() => void decide(true)}
              className="rounded bg-ok px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={state === 'sending'}
              onClick={() => void decide(false)}
              className="rounded border border-border-subtle px-3 py-1 text-sm disabled:opacity-50"
            >
              Reject
            </button>
            {error && <span className="text-xs text-danger">{error}</span>}
          </div>
        )
      ) : (
        <>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => prefill('Approved — go ahead.')}
              className="rounded border border-border-subtle bg-surface-raised px-3 py-1 text-sm"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => prefill('Do not proceed. ')}
              className="rounded border border-border-subtle bg-surface-raised px-3 py-1 text-sm"
            >
              Decline
            </button>
          </div>
          <p className="mt-1.5 text-xs text-ink-muted">
            This is a plan approval — it is answered by your next message, not by a separate
            action. These buttons fill in the box below.
          </p>
        </>
      )}
    </div>
  );
}
