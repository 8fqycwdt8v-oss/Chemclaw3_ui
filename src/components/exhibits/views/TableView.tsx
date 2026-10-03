/**
 * A table artefact: columns with units, rows of values, sortable, editable cell by cell.
 *
 * **A value here is one the agent wrote, or one bound to a tool result (wave 3).** A written value
 * is why the pane puts the unverified-figures strip above this table when the service flags any,
 * and why a chemist's correction of one cell is worth a revision of its own: it is the most
 * informative thing the system observes, and the agent is told about it next turn.
 *
 * A bound cell — or every cell, when the table is one `rows_from` binding — carries a provenance
 * marker and is **read-only until detached**: correcting a value that claims to be a tool's output
 * would leave the claim standing over a number the tool never returned. Detach first makes it the
 * chemist's own; then it edits like any other cell. Every write starts from `raw_spec`, so the
 * bindings an edit did not touch go back verbatim.
 *
 * ## The unit is in the header, never in the cell
 *
 * `columns[].unit` is the service's field and the only place a unit is stated. A header reads
 * `Yield (%)`; a cell reads `82`. Nothing here infers a unit from a label or appends one to a
 * number, for the reason `Mention.values` gives in `chem/entities.ts`: a unit the payload did not
 * state is a claim the surface invented.
 *
 * ## Sorting is a view, editing is a revision
 *
 * Sorting reorders what is drawn and nothing else — the spec's row order is the agent's (or the
 * last editor's), and a save writes it back unchanged. An edit addresses a row by its index in the
 * *spec*, never by where it is drawn, so sorting by yield and then correcting row three corrects
 * the row the chemist clicked rather than the third row of the document.
 *
 * Editing is offered on the head only, as in `DocumentView`, and through the same `useRevise`, so a
 * 409 is the same rebase prompt with the same diff.
 */

import { useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import {
  isBind as isBound,
  type ExhibitView,
  type TableCell,
  type TableColumn,
  type TableSpec,
} from '../../../../shared/exhibits.ts';
import { formatScientificNumber } from '../../../lib/format.ts';
import { DownloadCsv } from '../../../results/renderers.tsx';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { RebasePrompt } from '../RebasePrompt.tsx';
import { useRevise } from '../useRevise.ts';
import { ProvenanceMarker, SOURCE_GONE } from '../Provenance.tsx';
import {
  canDetach,
  detach,
  pathOf,
  provenanceAt,
  rawOf,
  type BoundTarget,
  type Provenance,
} from '../bindings.ts';

/** How many rows are drawn before the reader is asked — `FULL_ROW_LIMIT`'s argument in
 *  `results/renderers.tsx`, at the service's own cap of 2,000 rows. The CSV is always every row. */
const ROWS_SHOWN = 200;

/** A column's header as a chemist reads it: the label, and the unit when one was stated. */
export const headerOf = (column: TableColumn): string =>
  column.unit ? `${column.label} (${column.unit})` : column.label;

/** A cell as text. A number through `formatScientificNumber`, never the browser's locale. */
const shown = (value: TableCell | undefined): string =>
  value === null || value === undefined
    ? '—'
    : typeof value === 'number'
      ? formatScientificNumber(value)
      : value;

/**
 * What a typed cell becomes.
 *
 * Empty is `null` — "no value", which the service's cell type has a member for. Otherwise a number
 * when the column was holding a number (or nothing) *and* the text is one; text stays text. A cell
 * that was text is never coerced to a number by an edit, because a sample id `007` is not seven.
 */
export function parseCell(text: string, previous: TableCell | undefined): TableCell {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (typeof previous !== 'string') {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  return text;
}

type Sort = { key: string; direction: 'ascending' | 'descending' } | null;

function compare(a: TableCell | undefined, b: TableCell | undefined): number {
  // Absent values last whichever way the column is sorted — an empty cell is not "smallest".
  const aMissing = a === null || a === undefined;
  const bMissing = b === null || b === undefined;
  if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

export function TableView({
  sessionId,
  view,
  spec,
  isHead,
}: {
  sessionId: string;
  view: ExhibitView;
  spec: TableSpec;
  isHead: boolean;
}): React.JSX.Element {
  const [sort, setSort] = useState<Sort>(null);
  const [all, setAll] = useState(false);
  const [editing, setEditingState] = useState<{
    row: number;
    key: string;
    text: string;
    /** The revision this cell edit was started on — what the save names as its parent. */
    base: number;
  } | null>(null);
  // Mirrored in a ref because a cell commits on Enter *and* on blur, and the input unmounting after
  // an Enter can blur it: the second commit must find nothing to commit, not the stale closure's
  // copy of the edit, or one keystroke would write two revisions.
  const pending = useRef<typeof editing>(null);
  const setEditing = (next: typeof editing): void => {
    pending.current = next;
    setEditingState(next);
  };
  const revise = useRevise(sessionId, view);
  // The stored spec every write starts from; `null` only when the service sent none it could read.
  const raw = rawOf(view, 'table');
  // A table bound whole: every cell is the tool's, and the one marker is above the table.
  const rowsFrom = provenanceAt(view, { at: 'rows_from' });

  // Row indexes into the spec, in drawn order. Indexes rather than rows, so an edit addresses the
  // spec's row whatever order it is drawn in.
  const order = useMemo(() => {
    const indexes = spec.rows.map((_, i) => i);
    if (!sort) return indexes;
    const sign = sort.direction === 'ascending' ? 1 : -1;
    return indexes.sort((i, j) => {
      const c = compare(spec.rows[i]?.[sort.key], spec.rows[j]?.[sort.key]);
      // Missing values stay last in both directions; only real comparisons are flipped.
      const missing = spec.rows[i]?.[sort.key] == null || spec.rows[j]?.[sort.key] == null;
      return missing ? c : c * sign;
    });
  }, [spec.rows, sort]);

  if (revise.state.status === 'stale') {
    return (
      <RebasePrompt
        sessionId={sessionId}
        exhibitId={view.exhibit_id}
        base={revise.state.base}
        head={revise.state.head}
        saving={false}
        onRetry={() => void revise.retryOnHead()}
        onDiscard={revise.discard}
      />
    );
  }

  const toggleSort = (key: string): void =>
    setSort((current) =>
      current?.key !== key
        ? { key, direction: 'ascending' }
        : current.direction === 'ascending'
          ? { key, direction: 'descending' }
          : null,
    );

  const commit = async (): Promise<void> => {
    const edit = pending.current;
    if (!edit) return;
    const column = spec.columns.find((c) => c.key === edit.key);
    const previous = spec.rows[edit.row]?.[edit.key];
    const next = parseCell(edit.text, previous);
    setEditing(null);
    if (next === (previous ?? null)) return;
    // From the stored rows, so every binding in every other cell is sent back as it was stored.
    if (!raw?.rows) return;
    const rows = raw.rows.map((row, i) => (i === edit.row ? { ...row, [edit.key]: next } : row));
    await revise.save(
      { ...raw, rows },
      `Edited ${column ? headerOf(column) : edit.key} in row ${edit.row + 1}`,
      edit.base,
    );
  };

  /**
   * The detach for one bound position, or nothing where it cannot be offered. Built per render, so
   * the base is the revision drawn — `ProvenanceMarker` keeps the one its popover opened over.
   */
  const detachFor = (target: BoundTarget, provenance: Provenance): (() => void) | undefined => {
    if (!isHead || !raw || !canDetach(target, provenance)) return undefined;
    const base = view.revision;
    return () => {
      const next = detach(raw, spec, target);
      if (next) void revise.save(next, `Detached ${pathOf(target)} from its tool result`, base);
    };
  };

  const drawn = all ? order : order.slice(0, ROWS_SHOWN);
  // Aligned by column, not by cell: a column of figures reads down its decimal points, and an empty
  // cell in it is a dash in the figures' place rather than one hanging at the other edge.
  const numericColumns = new Set(
    spec.columns
      .filter((c) => spec.rows.some((row) => typeof row[c.key] === 'number'))
      .map((c) => c.key),
  );
  const headers = spec.columns.map(headerOf);
  // The CSV is keyed by the header the reader sees, so the file and the screen agree on what a
  // column is called and which unit it is in; `toCsv` carries the formula-injection guard.
  const records = spec.rows.map((row) =>
    Object.fromEntries(spec.columns.map((c) => [headerOf(c), row[c.key] ?? null])),
  );

  return (
    <div className="flex flex-col gap-2">
      {rowsFrom && (
        <p className="flex flex-wrap items-center gap-1.5 text-2xs text-ink-muted">
          <ProvenanceMarker
            provenance={rowsFrom}
            onDetach={detachFor({ at: 'rows_from' }, rowsFrom)}
            detachDisabled={revise.state.status === 'saving'}
          />
          Every row is taken from {rowsFrom.tool || 'a tool result'} at{' '}
          <span className="font-mono">{rowsFrom.pointer || '/'}</span>
          {rowsFrom.ok === false ? ` — ${SOURCE_GONE}.` : '.'} Read-only until detached.
        </p>
      )}
      <div
        tabIndex={0}
        role="region"
        aria-label={`${view.title} — table`}
        className="overflow-x-auto rounded-lg border border-border-subtle focus-ring"
      >
        <table className="w-full text-left text-xs">
          <thead className="bg-surface-sunken text-2xs text-ink-subtle">
            <tr>
              {spec.columns.map((column) => {
                const sorted = sort?.key === column.key ? sort.direction : undefined;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={sorted ?? 'none'}
                    className={cn(
                      'px-2.5 py-1.5 font-medium whitespace-nowrap',
                      numericColumns.has(column.key) && 'text-right',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(column.key)}
                      className="inline-flex items-center gap-1 rounded-sm hover:text-ink focus-ring"
                    >
                      {column.label}
                      {column.unit && <span className="text-ink-subtle"> ({column.unit})</span>}
                      {sorted === 'ascending' && <ArrowUp aria-hidden className="size-3" />}
                      {sorted === 'descending' && <ArrowDown aria-hidden className="size-3" />}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {drawn.map((rowIndex) => {
              const row = spec.rows[rowIndex] ?? {};
              return (
                <tr key={rowIndex}>
                  {spec.columns.map((column) => {
                    const value = row[column.key];
                    const numeric = numericColumns.has(column.key);
                    const isEditing = editing?.row === rowIndex && editing.key === column.key;
                    const target: BoundTarget = { at: 'cell', row: rowIndex, key: column.key };
                    const bound = rowsFrom ? null : provenanceAt(view, target);
                    return (
                      <td
                        key={column.key}
                        className={
                          numeric ? 'px-2.5 py-1 text-right font-mono tabular-nums' : 'px-2.5 py-1'
                        }
                      >
                        {bound ? (
                          <span className="inline-flex items-center gap-1">
                            {bound.ok === false ? (
                              <span className="text-2xs text-warn-ink">{SOURCE_GONE}</span>
                            ) : (
                              shown(value)
                            )}
                            <ProvenanceMarker
                              provenance={bound}
                              onDetach={detachFor(target, bound)}
                              detachDisabled={revise.state.status === 'saving'}
                            />
                          </span>
                        ) : isEditing ? (
                          <input
                            // A cell editor takes focus because the reader just asked to type in
                            // this cell; nothing else in the pane does.
                            // eslint-disable-next-line jsx-a11y/no-autofocus
                            autoFocus
                            aria-label={`${headerOf(column)}, row ${rowIndex + 1}`}
                            value={editing.text}
                            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void commit();
                              if (e.key === 'Escape') setEditing(null);
                            }}
                            onBlur={() => void commit()}
                            className="w-full min-w-16 rounded-sm border border-brand bg-surface-raised px-1 font-mono text-xs focus-ring"
                          />
                        ) : isHead && !rowsFrom && raw ? (
                          <button
                            type="button"
                            aria-label={`Edit ${headerOf(column)}, row ${rowIndex + 1}: ${shown(value)}`}
                            onClick={() =>
                              setEditing({
                                base: view.revision,
                                row: rowIndex,
                                key: column.key,
                                text: value === null || value === undefined ? '' : String(value),
                              })
                            }
                            disabled={revise.state.status === 'saving'}
                            className="w-full rounded-sm text-inherit hover:bg-surface-sunken focus-ring"
                            style={{ textAlign: 'inherit' }}
                          >
                            {shown(value)}
                          </button>
                        ) : (
                          shown(value)
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {revise.state.status === 'saving' && (
        <p role="status" className="text-2xs text-ink-muted">
          Saving your edit as a new revision…
        </p>
      )}
      {revise.state.status === 'failed' && (
        <p role="alert" className="text-xs text-danger-ink">
          {revise.state.message}
        </p>
      )}

      <div data-print="hide" className="flex flex-wrap items-center gap-2">
        {order.length > drawn.length && (
          <Button variant="outline" size="xs" onClick={() => setAll(true)}>
            Show all {order.length} rows
          </Button>
        )}
        <DownloadCsv headers={headers} records={records} name={view.title || view.exhibit_id} />
        {isHead && raw && !rowsFrom && (
          <span className="text-2xs text-ink-subtle">
            Select a cell to correct it
            {view.bindings.length > 0 || raw.rows?.some((r) => Object.values(r).some(isBound))
              ? '; a linked value is read-only until detached.'
              : '.'}
          </span>
        )}
      </div>
    </div>
  );
}
