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
 * The grounding legend in `AnswerFooter` is the one qualifier that is *not* hoisted, and the
 * exception proves the rule rather than breaking it. The warning it belongs to is already rendered
 * where it is read before belief: on the figure itself, inline in the body. What sits in the footer
 * is the legend and the evidence — what the marks mean, and the values they were checked against —
 * which is reference material a reader consults after meeting a mark, not a claim they must be
 * warned about before reading.
 */

import type { AssistantMessage } from '../state/types.ts';
import { capabilityLoss, returnedFigures } from '../chem/provenance.ts';

/**
 * How the turn's confidence — or its absence — was arrived at.
 *
 * The three cases are genuinely three different situations for a reviewer, and until now they all
 * rendered as the same sentence:
 *
 * - `judge`   — the LLM judge ran and scored the answer against what this turn's tools returned.
 * - `citation-gate` — the judge did not run. The deterministic fallback checks only that every
 *   cited id was in front of the model, which measures resolvability rather than faithfulness, and
 *   the backend measured it as the *more generous* of the two: the same cited-but-contradicted
 *   answer scored 1.0/supported here against 0.0/unsupported judged. A high score from this check
 *   is not the same object as a high score from the judge.
 * - `null`    — verification was off for this deployment, so nothing scored the answer at all. A
 *   `review_required` alongside it came from the answer-shape gate, which is a different check.
 */
function verifierNote(verifiedBy: AssistantMessage['verifiedBy']): string {
  switch (verifiedBy) {
    case 'judge':
      return 'Scored by the LLM judge against what this turn’s tools returned.';
    case 'citation-gate':
      return (
        'The judge did not run. This turn fell back to the deterministic citation gate, which ' +
        'only checks that every cited id was in front of the model — so nobody scored whether the ' +
        'answer follows from its evidence.'
      );
    default:
      return 'Answer verification is not enabled on this deployment, so nothing scored this answer.';
  }
}

/** The short form, for the confidence chip. */
function verifierLabel(verifiedBy: AssistantMessage['verifiedBy']): string {
  switch (verifiedBy) {
    case 'judge':
      return 'judge';
    case 'citation-gate':
      return 'citation gate';
    default:
      return 'unscored';
  }
}

export function ReviewRequiredPill({
  message,
}: {
  message: AssistantMessage;
}): React.JSX.Element | null {
  if (!message.reviewRequired) return null;

  // A turn the judge never scored and a turn the judge scored badly are different findings, and
  // the reviewer's next action differs: re-run the check, versus read the answer against its
  // evidence. They used to render as one sentence.
  const degraded = message.verifiedBy !== 'judge';
  const headline = degraded ? 'Needs expert review — and was not judged.' : 'Needs expert review.';
  const body =
    message.verifiedBy === 'judge'
      ? 'The verifier could not fully support this answer from the cited evidence.'
      : verifierNote(message.verifiedBy);

  return (
    <div className="mb-2 flex items-start gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2">
      <span aria-hidden>⚠️</span>
      <p className="text-sm text-warn">
        <span className="font-semibold">{headline}</span> {body}
      </p>
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
      <div className="text-sm text-warn">
        <p>
          <span className="font-semibold">Answered with fewer tools.</span> What this answer
          therefore does not contain:
        </p>
        {/* The chemistry statement, not the connector name. A chemist cannot act on "molfp was
            unreachable"; they can act on "no precedent search". The raw name still rides along in
            parentheses, because it is what an operator needs to check the deployment. */}
        <ul className="mt-1 space-y-0.5">
          {down.map((connector) => (
            <li key={connector} className="flex gap-1.5">
              <span aria-hidden>·</span>
              <span>
                {capabilityLoss(connector)}{' '}
                <span className="font-mono text-xs opacity-70">({connector})</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-1">Missing — not absent from the record.</p>
      </div>
    </div>
  );
}

function confidenceTone(value: number): { cls: string; label: string } {
  if (value >= 0.8) return { cls: 'border-ok/40 bg-ok-soft text-ok', label: 'high' };
  if (value >= 0.5) return { cls: 'border-warn/40 bg-warn-soft text-warn', label: 'moderate' };
  return { cls: 'border-danger/40 bg-danger-soft text-danger', label: 'low' };
}

/**
 * The legend for the inline figure marks, plus the values they were checked against.
 *
 * Deliberately no counts. A count computed here would be computed from the raw markdown, while the
 * marks are placed by a remark plugin walking the parsed tree — the two disagree about code
 * fences, link text and citation chips, and a footer reading "2 figures unmatched" beside one
 * highlighted figure is worse than no footer at all.
 *
 * What it offers instead is the thing a chemist actually wants next: the values the tools really
 * returned, behind one disclosure. That is the "expandable on demand" half of the overlay.
 */
function GroundingLegend({ message }: { message: AssistantMessage }): React.JSX.Element | null {
  const figures = returnedFigures(message.trace);
  if (figures.length === 0) return null;

  return (
    <details className="rounded border border-border-subtle bg-surface-sunken px-2 py-1.5">
      <summary className="cursor-pointer text-xs text-ink-muted">
        Figures checked against the {figures.length} value{figures.length === 1 ? '' : 's'} this
        turn’s tools returned
      </summary>
      <p className="mt-1.5 text-xs text-ink-muted">
        A figure marked{' '}
        <span className="rounded-sm border-b border-ok/60 bg-ok-soft px-0.5 text-ok">like this</span>{' '}
        matches one of them. One marked{' '}
        <span className="rounded-sm border-b border-warn/70 bg-warn-soft px-0.5 text-warn">
          like this
        </span>{' '}
        does not — which may mean it was derived or converted from one, since the values carry no
        units, so read it as “check this”, not as “this is invented”. Whole numbers are never
        marked as missing: they are counts and equivalents far more often than measurements.
      </p>
      <p className="mt-1.5 break-words font-mono text-xs text-ink">{figures.join(', ')}</p>
    </details>
  );
}

export function AnswerFooter({
  message,
}: {
  message: AssistantMessage;
}): React.JSX.Element | null {
  const hasConfidence = message.confidence !== null;
  const hasClaims = message.unsupportedClaims.length > 0;
  // Rendered whenever a check ran, not only when it produced a score: "the judge never ran" is a
  // fact about this answer even on a turn with no confidence number to show.
  const hasVerifier = message.verifiedBy !== null;
  const hasFigures = returnedFigures(message.trace).length > 0;
  if (!hasConfidence && !hasClaims && !hasVerifier && !hasFigures) return null;

  const tone = hasConfidence ? confidenceTone(message.confidence as number) : null;

  return (
    <div className="mt-3 space-y-2 border-t border-border-subtle pt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {tone && (
          <span
            className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs ${tone.cls}`}
            title="Citation-faithfulness score from the answer verifier"
          >
            <span className="font-medium">{tone.label} confidence</span>
            <span className="font-mono">{(message.confidence as number).toFixed(2)}</span>
          </span>
        )}

        {hasVerifier && (
          // Beside the score rather than inside it: which check ran is a different question from
          // what the check concluded, and a score shown without it invites reading a citation-gate
          // 1.00 as a judged 1.00.
          <span
            className="inline-flex items-center rounded border border-border-subtle bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted"
            title={verifierNote(message.verifiedBy)}
          >
            checked by: {verifierLabel(message.verifiedBy)}
          </span>
        )}
      </div>

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

      <GroundingLegend message={message} />
    </div>
  );
}
