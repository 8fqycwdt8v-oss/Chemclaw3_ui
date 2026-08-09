/**
 * Verifier signals on an answer.
 *
 * These are populated only when the backend's answer verifier is enabled; otherwise confidence
 * is null and the flags are false, and this renders nothing.
 *
 * `review_required` deliberately renders at the TOP of the answer card, not the bottom: a warning
 * placed after the text is read only once the reader has already believed it.
 *
 * `CapabilityDegradedPill` is placed by the same rule, and matters more: the backend emits it
 * before the first token precisely so a surface can qualify the answer *while* it streams. It also
 * says the one thing the reader cannot otherwise know — that "the ELN says nothing about that
 * batch" and "the ELN was unreachable" would have arrived as the same sentence.
 */

import type { AssistantMessage } from '../state/types.ts';

export function ReviewRequiredPill({
  message,
}: {
  message: AssistantMessage;
}): React.JSX.Element | null {
  if (!message.reviewRequired) return null;
  // Three independent conditions raise `reviewRequired`, and they do not mean the same thing, so
  // the copy no longer asserts the verifier scored it low. `verified_by === 'citation-gate'` in
  // particular means the LLM judge did not run at all — this answer was scored by the weaker
  // deterministic check — which a reader must be able to tell apart from a genuine low score.
  const judgeMissing = message.verifiedBy === 'citation-gate';
  return (
    <div className="mb-2 flex items-start gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2">
      <span aria-hidden>⚠️</span>
      <p className="text-sm text-warn">
        <span className="font-semibold">Needs expert review.</span>{' '}
        {judgeMissing
          ? 'The reviewing model did not run, so this answer was checked only by the weaker citation gate.'
          : 'This answer was not fully supported by the evidence gathered for it.'}
      </p>
    </div>
  );
}

/**
 * A guard cut the turn short, but it still produced an answer.
 *
 * `loop_cap_reached` and `empty_answer` arrive BEFORE the answer they describe — the same "mark
 * it partial while it is still arriving" ordering `CapabilityDegradedPill` uses — so this renders
 * above the body for the same reason. It is not an error card: the turn did not fail, and the text
 * below it is real.
 */
export function TurnNoticePill({
  message,
}: {
  message: AssistantMessage;
}): React.JSX.Element | null {
  const notice = message.notice;
  // A failed turn renders its own error card; showing both would say it twice and disagree.
  if (!notice || message.status === 'error') return null;

  const copy =
    notice.code === 'loop_cap_reached'
      ? 'This answer is partial — the turn reached its step limit with work still open.'
      : notice.code === 'empty_answer'
        ? 'The turn finished without producing an answer. Try asking something narrower.'
        : notice.message;

  return (
    <div className="mb-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2">
      <p className="flex items-start gap-2 text-sm text-warn">
        <span aria-hidden>⏱️</span>
        <span>{copy}</span>
      </p>
      {notice.correlationId && (
        <p className="mt-1 font-mono text-[0.7rem] text-ink-muted">
          Reference: {notice.correlationId}
        </p>
      )}
    </div>
  );
}

export function CapabilityDegradedPill({
  message,
}: {
  message: AssistantMessage;
}): React.JSX.Element | null {
  const down = message.degradedConnectors;
  if (down.length === 0) return null;
  return (
    <div className="mb-2 flex items-start gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2">
      <span aria-hidden>🔌</span>
      <p className="text-sm text-warn">
        <span className="font-semibold">Answered with fewer tools.</span> {down.join(', ')}{' '}
        {down.length === 1 ? 'was' : 'were'} unreachable for this turn, so anything only{' '}
        {down.length === 1 ? 'it' : 'they'} can reach is missing — not absent from the record.
      </p>
    </div>
  );
}

function confidenceTone(value: number): { cls: string; label: string } {
  if (value >= 0.8) return { cls: 'border-ok/40 bg-ok-soft text-ok', label: 'high' };
  if (value >= 0.5) return { cls: 'border-warn/40 bg-warn-soft text-warn', label: 'moderate' };
  return { cls: 'border-danger/40 bg-danger-soft text-danger', label: 'low' };
}

export function AnswerFooter({ message }: { message: AssistantMessage }): React.JSX.Element | null {
  const hasConfidence = message.confidence !== null;
  const hasClaims = message.unsupportedClaims.length > 0;
  if (!hasConfidence && !hasClaims) return null;

  const tone = hasConfidence ? confidenceTone(message.confidence as number) : null;

  return (
    <div className="mt-3 space-y-2 border-t border-border-subtle pt-2">
      {tone && (
        <span
          className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs ${tone.cls}`}
          title="Citation-faithfulness score from the answer verifier"
        >
          <span className="font-medium">{tone.label} confidence</span>
          <span className="font-mono">{(message.confidence as number).toFixed(2)}</span>
        </span>
      )}

      {hasClaims && (
        <details className="rounded border border-danger/40 bg-danger-soft px-2 py-1.5">
          <summary className="cursor-pointer text-xs font-medium text-danger">
            {message.unsupportedClaims.length} unsupported claim
            {message.unsupportedClaims.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-1.5 space-y-1">
            {message.unsupportedClaims.map((claim, i) => (
              <li key={i} className="text-xs text-ink">
                {claim}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
