/**
 * One number, its unit and its uncertainty — rendered as one thing.
 *
 * The uncertainty is on the value line, not below it and not in a footnote. That placement is the
 * backend's own, and it argues for itself in `Estimate.render`: a trust stanza appended under a
 * value is the first thing a truncating consumer cuts, "so the trust travels *on* the value line
 * or it does not travel". The same holds for a reader's eye.
 *
 * Three states are kept apart because collapsing any two of them is a claim nobody made:
 *
 *  - **an uncertainty of zero** would say the prediction is exact, so a calculator that states
 *    none renders as "no uncertainty stated" and not as `± 0`;
 *  - **an unasked applicability question** (`in_domain: null`) is not a passed one — a consumer
 *    that reads it as "fine" is the bug the third value exists to expose;
 *  - **out of domain** is not merely less accurate. It is a number the calculator says does not
 *    describe this molecule, so it is a `danger` callout beside the value rather than a caveat
 *    underneath it.
 */

import { cn } from '../../lib/cn.ts';
import { toolLabel } from '../../lib/format.ts';
import { Molecule } from '../Molecule.tsx';
import { formatNumber, type ValueWithUncertainty } from './shapes.ts';

export function ValueCard({ result }: { result: ValueWithUncertainty }): React.JSX.Element {
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-medium">{toolLabel(result.title)}</h4>

      <div className="flex flex-wrap items-center gap-3 rounded-md border border-border-subtle bg-surface-raised p-3">
        {result.subject && <Molecule smiles={result.subject} width={170} height={120} />}
        <div>
          <p className="font-mono text-lg">
            {formatNumber(result.value)}
            {result.uncertainty !== null && (
              <span className="text-ink-muted"> ± {formatNumber(result.uncertainty)}</span>
            )}
            <span className="ml-1.5 text-sm text-ink-muted">{result.unit}</span>
          </p>
          <p className="text-xs text-ink-muted">
            {result.uncertainty === null
              ? 'No uncertainty stated by this calculator — which is not the same as none.'
              : (result.uncertaintyBasis ?? 'one standard deviation, as the calculator reports it')}
          </p>
          {result.method && (
            <p className="mt-0.5 font-mono text-xs text-ink-muted">{result.method}</p>
          )}
        </div>
      </div>

      {result.inDomain === false && (
        <p className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
          Out of this calculator’s applicability domain
          {result.domainReasons.length > 0 && `: ${result.domainReasons.join('; ')}`}. The number
          above does not describe this molecule.
        </p>
      )}
      {result.inDomain === null && (
        <p className={cn('text-xs text-ink-muted')}>
          Applicability not assessed — this calculator declares no domain, so the question was not
          asked rather than answered.
        </p>
      )}

      {result.extras.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {result.extras.map((extra) => (
            <div key={extra.label} className="contents">
              <dt className="text-ink-muted">{extra.label}</dt>
              <dd className="break-all font-mono">{extra.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
