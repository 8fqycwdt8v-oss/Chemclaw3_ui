/**
 * A table of rows — a charge table, an ICH limit lookup, a calibration outlier listing.
 *
 * Two things this renderer is careful about, and both are about what is *missing* from a table
 * rather than what is in it.
 *
 * A `ChargeTable` carries `unresolved`: the reagents that did not resolve and are therefore in no
 * row. A chemist reading eight rows has no way to see that a ninth was asked for, so the notice
 * is rendered above the table in `danger` — a silently-dropped reagent is not an incomplete table,
 * it is a wrong one, and it is wrong in the direction of a charge somebody might weigh out.
 *
 * An `ImpurityLimitLookup` miss and an `OutlierReport` with the ledger disabled are both empty
 * tables that mean "this system does not carry the number", not "the number is zero" or "there is
 * nothing wrong". Both payloads spell that out in a `verdict` they were given specifically so the
 * sentence would leave the process; both are rendered verbatim rather than paraphrased.
 */

import { cn } from '../../lib/cn.ts';
import { Molecule } from '../Molecule.tsx';
import type { RowTable as RowTableResult } from './shapes.ts';

export function RowTable({ result }: { result: RowTableResult }): React.JSX.Element {
  // A column nothing populates is dropped: an all-"—" density column on a table with no solvent
  // row is noise between the numbers a chemist is reading across.
  const columns = result.columns.filter((column) =>
    result.rows.some((row) => (row[column.key] ?? '—') !== '—'),
  );
  const structures = result.structures.filter((smiles): smiles is string => smiles !== null);

  return (
    <section className="space-y-2">
      <h4 className="text-sm font-medium">{result.title}</h4>
      {result.caption && <p className="text-xs text-ink-muted">{result.caption}</p>}

      {result.notices.map((notice, i) => (
        <p
          key={i}
          className={cn(
            'rounded-md border px-3 py-2 text-sm',
            notice.tone === 'danger'
              ? 'border-danger/40 bg-danger-soft text-danger'
              : 'border-warn/40 bg-warn-soft text-warn',
          )}
        >
          {notice.text}
        </p>
      ))}

      {result.rows.length > 0 && columns.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border-subtle bg-surface-raised">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border-subtle">
                {columns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={cn(
                      'px-2 py-1.5 text-xs font-medium text-ink-muted',
                      column.numeric ? 'text-right' : 'text-left',
                    )}
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i} className="border-b border-border-subtle last:border-b-0">
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={cn(
                        'px-2 py-1.5',
                        column.numeric ? 'text-right font-mono tabular-nums' : 'break-all',
                      )}
                    >
                      {row[column.key] ?? '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {structures.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-ink-muted">
            {structures.length} structure{structures.length === 1 ? '' : 's'} in this table
          </summary>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {structures.map((smiles, i) => (
              <Molecule key={`${smiles}-${i}`} smiles={smiles} width={150} height={110} />
            ))}
          </div>
        </details>
      )}

      {result.verdict && <p className="text-xs text-ink-muted">{result.verdict}</p>}
    </section>
  );
}
