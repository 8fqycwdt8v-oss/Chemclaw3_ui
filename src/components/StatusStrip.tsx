/**
 * Everything that qualifies an answer, ranked by what the reader has to do.
 *
 * **A bar** ("do not act on this yet"): `review_required` and a cut-short turn keep full width and
 * `role="alert"`. **A chip** ("narrower, or better founded, than it looks"): a missing connector,
 * the verifier's score, the methods behind the numbers; one row, expanding in place. Chips state
 * lost capability in chemistry terms (`capabilityLoss`), with the connector name alongside.
 * Provenance sits above the answer, before the reader believes it.
 */

import { useState } from 'react';
import { ChevronRight, FlaskConical, Scissors, TriangleAlert, Unplug } from 'lucide-react';
import type { AssistantMessage } from '../state/types.ts';
import type { AnswerCheck } from '../../shared/events.ts';
import { capabilityLoss, methodsUsed } from '../chem/provenance.ts';
import { cn } from '@/lib/utils';

/**
 * A qualifier that interrupts. `role="alert"` is reserved for the two that change what the reader
 * is about to believe.
 */
function AlertBar({
  tone,
  icon,
  children,
}: {
  tone: 'danger' | 'warn';
  icon: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2.5 rounded-lg border px-3 py-2 text-sm',
        tone === 'danger'
          ? 'border-danger/40 bg-danger-soft text-danger-ink'
          : 'border-warn/40 bg-warn-soft text-warn-ink',
      )}
    >
      <span aria-hidden className="mt-0.5 shrink-0">
        {icon}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * One consultable fact, one line high. With `detail` it is a disclosing `<button>`, otherwise inert
 * text; styling is shared.
 */
function Chip({
  tone = 'neutral',
  icon,
  label,
  detail,
}: {
  tone?: 'neutral' | 'ok' | 'warn' | 'danger';
  icon?: React.ReactNode;
  label: React.ReactNode;
  /** Rendered underneath when the chip is opened. Omit for a chip with nothing more to say. */
  detail?: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const classes = cn(
    'inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs',
    tone === 'neutral' && 'border-border-subtle bg-surface-raised text-ink-muted',
    tone === 'ok' && 'border-ok/40 bg-ok-soft text-ok-ink',
    tone === 'warn' && 'border-warn/40 bg-warn-soft text-warn-ink',
    tone === 'danger' && 'border-danger/40 bg-danger-soft text-danger-ink',
  );

  if (!detail) {
    return (
      <span className={classes}>
        {icon}
        <span className="truncate">{label}</span>
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(classes, 'focus-ring transition-colors hover:border-border-strong')}
      >
        {icon}
        <span className="truncate">{label}</span>
        <ChevronRight
          aria-hidden
          className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')}
        />
      </button>
      {open && <p className="basis-full text-xs text-ink-muted">{detail}</p>}
    </>
  );
}

/**
 * What produced the score. The citation gate is deterministic over this turn's tool results; the
 * judge is a model scoring the claims. Their scores are not comparable.
 */
const VERIFIER_LABEL: Record<'judge' | 'citation-gate', string> = {
  judge: 'scored by a model judge',
  'citation-gate': 'scored against this turn’s evidence',
};

/**
 * What each answer check looked at, in a chemist's words. Unknown checks are dropped at parse time
 * (`listOf(ANSWER_CHECKS)` in `shared/events.ts`), so a new check needs adding there and here.
 */
const CHECK_LABEL: Record<AnswerCheck, string> = {
  verifier: 'citations',
  'answer-shape': 'answer shape',
};

function confidenceTone(value: number): { tone: 'ok' | 'warn' | 'danger'; label: string } {
  if (value >= 0.8) return { tone: 'ok', label: 'high' };
  if (value >= 0.5) return { tone: 'warn', label: 'moderate' };
  return { tone: 'danger', label: 'low' };
}

export function StatusStrip({ message }: { message: AssistantMessage }): React.JSX.Element | null {
  const { confidence, unsupportedClaims, verifiedBy, degradedConnectors } = message;
  const methods = methodsUsed(message.trace);
  const scored = confidence !== null ? confidenceTone(confidence) : null;
  // Absent on a message persisted before this was read, which means the same as none — see
  // `AssistantMessage.checksRun`.
  const checksRun = message.checksRun ?? [];

  const hasBar = message.reviewRequired || message.partialReason !== null;
  const hasChip =
    degradedConnectors.length > 0 ||
    scored !== null ||
    methods.length > 0 ||
    unsupportedClaims.length > 0 ||
    checksRun.length > 0 ||
    message.challenged === true;
  if (!hasBar && !hasChip) return null;

  return (
    <div className="mb-3 flex flex-col gap-2">
      {message.reviewRequired && (
        <AlertBar tone="danger" icon={<TriangleAlert className="size-4" />}>
          <span className="font-semibold">Needs expert review.</span> The verifier could not fully
          support this answer from the cited evidence.
        </AlertBar>
      )}

      {message.partialReason && (
        <AlertBar tone="warn" icon={<Scissors className="size-4" />}>
          <span className="font-semibold">Cut short.</span> {message.partialReason}
          {/* Sent before the answer, so the reader meets it above the text. */}
          <span className="mt-1 block">
            What follows is what the turn managed, not what it set out to do.
          </span>
        </AlertBar>
      )}

      {/* Severity order, left to right: what is wrong, what was missing, how well it scored, what produced it. */}
      {hasChip && (
        <div className="flex flex-wrap items-center gap-1.5">
          {unsupportedClaims.length > 0 && (
            <Chip
              tone="danger"
              label={`${unsupportedClaims.length} unsupported claim${
                unsupportedClaims.length === 1 ? '' : 's'
              }`}
              detail={
                <ul className="mt-0.5 space-y-1 pl-4">
                  {unsupportedClaims.map((claim, i) => (
                    <li key={i} className="list-disc text-danger-ink marker:text-danger">
                      {claim}
                    </li>
                  ))}
                </ul>
              }
            />
          )}

          {degradedConnectors.map((connector) => (
            <Chip
              key={connector}
              tone="warn"
              icon={<Unplug aria-hidden className="size-3 shrink-0" />}
              label={
                <>
                  {capabilityLoss(connector)}{' '}
                  {/* De-emphasised by size and parentheses, not opacity: altering an `-ink` token's alpha breaks its measured contrast. */}
                  <span className="font-mono text-2xs">({connector})</span>
                </>
              }
              detail="Missing — not absent from the record. The tools this connector serves were not available for this turn, so the answer was assembled without them."
            />
          ))}

          {message.challenged === true && (
            <Chip
              tone="warn"
              label="challenged by a second pass"
              detail={
                message.reviewHoldId
                  ? `A review is open on this answer: ${message.reviewHoldId}.`
                  : 'A second pass disagreed with this answer. No review id was reported with it.'
              }
            />
          )}

          {scored && confidence !== null && (
            <Chip
              tone={scored.tone}
              label={
                <>
                  <span className="font-mono tabular-nums">{confidence.toFixed(2)}</span>{' '}
                  <span className="opacity-80">{scored.label} confidence</span>
                </>
              }
              detail={verifiedBy ? VERIFIER_LABEL[verifiedBy] : 'no verifier reported'}
            />
          )}

          {/* What looked at this answer (distinct from its score). No chip here means it was not checked, which is the ordinary case with both gates off. */}
          {checksRun.length > 0 && (
            <Chip
              tone="ok"
              label={`checked · ${checksRun.map((check) => CHECK_LABEL[check]).join(' · ')}`}
              detail="A check that ran and found nothing is not the same as no check having run. An answer with nothing named here was not verified."
            />
          )}

          {methods.length > 0 && (
            <Chip
              icon={<FlaskConical aria-hidden className="size-3 shrink-0" />}
              label={methods.join(' · ')}
              detail="What each method does not establish is on its step in the agent’s work below."
            />
          )}
        </div>
      )}
    </div>
  );
}
