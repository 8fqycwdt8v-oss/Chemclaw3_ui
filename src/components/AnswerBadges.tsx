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
 *
 * Both carry `role="alert"`: they qualify what the reader is about to believe, so they are the one
 * class of message here that should interrupt rather than wait its turn.
 */

import { ChevronRight, TriangleAlert, Unplug } from 'lucide-react';
import type { AssistantMessage } from '../state/types.ts';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

function Notice({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      role="alert"
      className="mb-3 flex items-start gap-2.5 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2.5"
    >
      <span aria-hidden className="mt-0.5 shrink-0 text-warn">
        {icon}
      </span>
      <p className="text-sm text-warn-ink">{children}</p>
    </div>
  );
}

export function ReviewRequiredPill({
  message,
}: {
  message: AssistantMessage;
}): React.JSX.Element | null {
  if (!message.reviewRequired) return null;
  return (
    <Notice icon={<TriangleAlert className="size-4" />}>
      <span className="font-semibold">Needs expert review.</span> The verifier could not fully
      support this answer from the cited evidence.
    </Notice>
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
    <Notice icon={<Unplug className="size-4" />}>
      {/* The joined list stays one text node: it reads as a sentence, and it is asserted as one. */}
      <span className="font-semibold">Answered with fewer tools.</span> {down.join(', ')}{' '}
      {down.length === 1 ? 'was' : 'were'} unreachable for this turn, so anything only{' '}
      {down.length === 1 ? 'it' : 'they'} can reach is missing — not absent from the record.
    </Notice>
  );
}

function confidenceTone(value: number): { tone: 'ok' | 'warn' | 'danger'; label: string } {
  if (value >= 0.8) return { tone: 'ok', label: 'high' };
  if (value >= 0.5) return { tone: 'warn', label: 'moderate' };
  return { tone: 'danger', label: 'low' };
}

/**
 * What produced the score, in the fewest words that stay true.
 *
 * The two backends are not two implementations of one measurement. The citation gate is
 * deterministic and scores the answer against the tool results this turn actually saw; the judge
 * is a model scoring it against the claims. A reader comparing 0.82 from one against 0.82 from the
 * other is comparing nothing, and the number alone gives them no way to know that.
 */
const VERIFIER_LABEL: Record<'judge' | 'citation-gate', string> = {
  judge: 'scored by a model judge',
  'citation-gate': 'scored against this turn’s evidence',
};

export function AnswerFooter({ message }: { message: AssistantMessage }): React.JSX.Element | null {
  const { confidence, unsupportedClaims, verifiedBy } = message;
  if (confidence === null && unsupportedClaims.length === 0) return null;

  const scored = confidence !== null ? confidenceTone(confidence) : null;

  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-border-subtle pt-3">
      {scored && confidence !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={scored.tone}>
            <span className="font-mono tabular-nums">{confidence.toFixed(2)}</span>
            <span className="font-normal opacity-80">{scored.label} confidence</span>
          </Badge>
          {verifiedBy && (
            <span className="text-2xs text-ink-muted">{VERIFIER_LABEL[verifiedBy]}</span>
          )}
        </div>
      )}

      {unsupportedClaims.length > 0 && (
        <details className="group rounded-md border border-danger/40 bg-danger-soft px-2.5 py-2">
          <summary
            className={cn(
              'flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-danger-ink',
              'tap-target rounded-sm focus-ring',
            )}
          >
            <ChevronRight
              aria-hidden
              className="size-3.5 transition-transform group-open:rotate-90"
            />
            {unsupportedClaims.length} claim{unsupportedClaims.length === 1 ? '' : 's'} the verifier
            could not support
          </summary>
          <ul className="mt-2 space-y-1 pl-5">
            {unsupportedClaims.map((claim, i) => (
              <li key={i} className="list-disc text-xs text-danger-ink marker:text-danger">
                {claim}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
