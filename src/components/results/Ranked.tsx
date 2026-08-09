/**
 * A ranked comparison — a solvent screen, a similarity search.
 *
 * Rendered as a ranking rather than as a list of numbers, because that is the claim these results
 * are entitled to make and the only one. `compare_solvents`' own manifest says it outright — "the
 * differences between solvents are more trustworthy than any single value; say so when reporting"
 * — so the primary column here is the difference from the leader, and each solvent's absolute
 * energy sits beside it in a muted secondary position rather than the other way round.
 *
 * The framing line above the list is the part that must not be lost. For a solvent screen it says
 * whether the calculation distinguished the solvents at all; for a search it is the payload's own
 * `verdict`, which exists so an unbuilt fingerprint index cannot render as "we have never made
 * anything like this". Both are rendered verbatim.
 */

import { cn } from '../../lib/cn.ts';
import { CitationChip } from '../CitationChip.tsx';
import { Molecule, Reaction } from '../Molecule.tsx';
import type { RankedComparison } from './shapes.ts';

export function Ranked({ result }: { result: RankedComparison }): React.JSX.Element {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-medium">{result.title}</h4>
        <span className="text-xs text-ink-muted">{result.scoreLabel}</span>
      </div>

      {result.framing && (
        <p
          className={cn(
            'rounded-md border px-3 py-2 text-sm',
            result.framingIsWarning
              ? 'border-warn/40 bg-warn-soft text-warn'
              : 'border-border-subtle bg-surface text-ink-muted',
          )}
        >
          {result.framing}
        </p>
      )}

      {result.items.length > 0 && (
        <ol className="space-y-1.5">
          {result.items.map((item, i) => (
            <li
              key={`${item.label}-${i}`}
              className="rounded-md border border-border-subtle bg-surface-raised p-2"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                {/* The position, stated. A list a reader has to count is a list whose order they
                    have to infer, and the order is the whole result. */}
                <span className="w-5 shrink-0 text-xs text-ink-muted">{i + 1}.</span>
                <span className="break-all text-sm font-medium">{item.label}</span>
                <span className="ml-auto font-mono text-sm">{item.score}</span>
              </div>
              {item.detail && <p className="ml-7 text-xs text-ink-muted">{item.detail}</p>}
              {item.noteId && (
                <p className="ml-7 mt-1">
                  <CitationChip kind="note" id={item.noteId} />
                </p>
              )}
              {item.smiles && (
                <div className="ml-7 mt-1">
                  <Molecule smiles={item.smiles} width={170} height={120} />
                </div>
              )}
              {item.reactionSmiles && (
                <div className="ml-7 mt-1">
                  <Reaction reactionSmiles={item.reactionSmiles} width={110} height={80} />
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      {result.warnings.length > 0 && (
        <ul className="space-y-1">
          {result.warnings.map((warning, i) => (
            <li
              key={i}
              className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn"
            >
              {warning}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
