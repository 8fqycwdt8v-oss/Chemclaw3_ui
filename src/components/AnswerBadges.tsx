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
 * It names what the absence cost the ANSWER rather than which connector was down. "safety was
 * unreachable" is a fact about a pod and a chemist can do nothing with it; "no hazard screen, no
 * genotoxicity alerts and no ICH impurity limits" is the same fact stated as what they now have to
 * do about it. The connector name still rides along for whoever has to check the deployment.
 * `src/chem/provenance.ts` owns the mapping and stays honest about a name it has never seen — the
 * event's own contract warns that one need not resolve in the registry.
 *
 * Both carry `role="alert"`: they qualify what the reader is about to believe, so they are the one
 * class of message here that should interrupt rather than wait its turn.
 *
 * `AnswerFooter` also carries the turn's methods, which is the one qualifier here that is not the
 * verifier's. See `MethodLine` for why it is a line and not a stack of caveats.
 */

import { ChevronRight, FlaskConical, Scissors, TriangleAlert, Unplug } from 'lucide-react';
import type { AssistantMessage, TraceEntry } from '../state/types.ts';
import { capabilityLoss, methodsUsed } from '../chem/provenance.ts';
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

export function PartialAnswerPill({
  message,
}: {
  message: AssistantMessage;
}): React.JSX.Element | null {
  if (!message.partialReason) return null;
  return (
    <Notice icon={<Scissors className="size-4" />}>
      <span className="font-semibold">Cut short.</span> {message.partialReason}
      {/* The service sends this BEFORE the answer, deliberately, so the reader meets it above the
          text rather than discovering afterwards that the text was not the whole job. The turn is
          not failed by it: what follows is real work, it is just not finished work. */}
      <span className="mt-1 block">
        What follows is what the turn managed, not what it set out to do.
      </span>
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
      <span className="font-semibold">Answered with fewer tools.</span> This answer therefore
      contains:
      {/* The chemistry statement, not the connector name. A chemist cannot act on "molfp was
          unreachable"; they can act on "no precedent search". The raw name still rides along in
          parentheses, because it is what an operator needs to check the deployment. */}
      <span className="mt-1 block">
        {down.map((connector) => (
          <span key={connector} className="flex gap-1.5">
            <span aria-hidden>·</span>
            <span>
              {capabilityLoss(connector)}{' '}
              <span className="font-mono text-2xs opacity-70">({connector})</span>
            </span>
          </span>
        ))}
      </span>
      <span className="mt-1 block">Missing — not absent from the record.</span>
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

/**
 * What produced this turn's numbers, in one line.
 *
 * The method a value came from used to be four disclosures deep — behind "Show the agent's work",
 * then the row for the call, then the badge on it — while the value itself sat in the answer at
 * depth 0. Provenance was inverted relative to risk, and a qualifier at that depth is a qualifier
 * nobody reads.
 *
 * This is deliberately the shortest thing that fixes it: the distinct methods, once, with no
 * caveats. The caveats are two to four lines each and belong exactly where they are, one
 * disclosure into the trace — stacking five of them here would be the annotation clutter that
 * trains a reader to skip the whole footer, which is worse than the depth was.
 *
 * Nothing renders for a turn whose tools this repo has no sourced method for. A confidently wrong
 * method label is worse than a missing one, and that does not change by being higher up the page.
 */
function MethodLine({ trace }: { trace: readonly TraceEntry[] }): React.JSX.Element | null {
  const methods = methodsUsed(trace);
  if (methods.length === 0) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-2xs text-ink-muted">
      <FlaskConical aria-hidden className="size-3 shrink-0" />
      <span>Computed by</span>
      {methods.map((method, i) => (
        <span key={method}>
          <span className="text-ink">{method}</span>
          {i < methods.length - 1 && <span aria-hidden> ·</span>}
        </span>
      ))}
      <span className="text-ink-subtle">
        — what each does not establish is in the agent’s work below.
      </span>
    </p>
  );
}

export function AnswerFooter({ message }: { message: AssistantMessage }): React.JSX.Element | null {
  const { confidence, unsupportedClaims, verifiedBy } = message;
  const methods = methodsUsed(message.trace);
  // The footer exists if there is anything to put in it. The method line is the third such thing,
  // and it is the one that renders on an ordinary turn with the verifier switched off — which is
  // most deployments, and was previously a turn with no footer at all.
  if (confidence === null && unsupportedClaims.length === 0 && methods.length === 0) return null;

  const scored = confidence !== null ? confidenceTone(confidence) : null;

  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-border-subtle pt-3">
      <MethodLine trace={message.trace} />
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
