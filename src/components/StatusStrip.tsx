/**
 * Everything that qualifies an answer, ranked instead of stacked.
 *
 * What this replaces was three amber boxes and a footer. Each box was carefully worded and each
 * was right; together they were 217 measured pixels of warning above a two-line answer, and on a
 * phone the first half of the screen. Three equal alarms is how a reader learns to skip amber, and
 * the cost of that lesson is paid on the one turn where the amber mattered.
 *
 * So the ranking is by what the reader has to *do*:
 *
 *   **A bar** — "do not act on this yet". `review_required` and a turn cut short both change
 *   whether the answer can be used at all, so they keep the full width and the `role="alert"`
 *   that interrupts. Nothing is softened and nothing is collapsed.
 *
 *   **A chip** — "this answer is narrower, or better founded, than it looks". A missing connector,
 *   the verifier's score, the methods behind the numbers: each is a fact about the answer's
 *   standing that a reader consults rather than obeys. One row, expanding in place.
 *
 * ## The chips carry the chemistry, not the plumbing
 *
 * `capabilityLoss` is what turns "safety was unreachable" — a fact about a pod, which a chemist
 * can do nothing with — into "no hazard screen, no genotoxicity alerts, no ICH impurity limits",
 * which is the same fact stated as what they now have to do about it. The connector's own name
 * rides along for whoever has to check the deployment.
 *
 * ## Provenance sits above the answer now, not under it
 *
 * The method a number came from used to be four disclosures deep while the number itself sat at
 * depth zero, and the fix at the time was a line in the footer. A footer is still below the text
 * it qualifies, which is below where the reader has already believed it. The method chip is the
 * same information at the altitude the risk actually has.
 */

import { useState } from 'react';
import { ChevronRight, FlaskConical, Scissors, TriangleAlert, Unplug } from 'lucide-react';
import type { AssistantMessage } from '../state/types.ts';
import { capabilityLoss, methodsUsed } from '../chem/provenance.ts';
import { cn } from '@/lib/utils';

/**
 * A qualifier that interrupts.
 *
 * `role="alert"` on both members, deliberately: these are the two that change what the reader is
 * about to believe, and they are the whole of the class. Everything else waits its turn.
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
 * One consultable fact, one line high.
 *
 * A chip with `detail` is a `<button>` that discloses it; one without is inert text. Two elements
 * for the same shape would be a second visual language for the same class of fact, so the styling
 * is shared and only the element changes.
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

/** What produced the score, in the fewest words that stay true. The citation gate is deterministic
 *  and scores against this turn's own tool results; the judge is a model scoring against the
 *  claims. A reader comparing 0.82 from one with 0.82 from the other is comparing nothing. */
const VERIFIER_LABEL: Record<'judge' | 'citation-gate', string> = {
  judge: 'scored by a model judge',
  'citation-gate': 'scored against this turn’s evidence',
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

  const hasBar = message.reviewRequired || message.partialReason !== null;
  const hasChip =
    degradedConnectors.length > 0 ||
    scored !== null ||
    methods.length > 0 ||
    unsupportedClaims.length > 0;
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
          {/* The service sends this BEFORE the answer, deliberately, so the reader meets it above
              the text rather than discovering afterwards that the text was not the whole job. */}
          <span className="mt-1 block">
            What follows is what the turn managed, not what it set out to do.
          </span>
        </AlertBar>
      )}

      {/* Severity order, left to right: what is wrong with the answer, what was missing from it,
          how well it scored, what produced it. A reader scanning the row meets the chips in the
          order they would act on them. */}
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
                  {/* De-emphasised by size and by the parentheses, NOT by opacity: multiplying an
                      `-ink` token's alpha silently un-chooses the colour that was measured to
                      pass on this ground. */}
                  <span className="font-mono text-2xs">({connector})</span>
                </>
              }
              detail="Missing — not absent from the record. The tools this connector serves were not available for this turn, so the answer was assembled without them."
            />
          ))}

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
