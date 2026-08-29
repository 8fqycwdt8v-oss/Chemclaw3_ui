/**
 * The plate, drawn as a plate.
 *
 * A `PlateLayout` is a list of wells with a row, a column and an arm, and read as a table it is
 * unusable: the question a chemist asks of a layout is *spatial* — is the positive control on the
 * edge, did the randomiser put both replicates of an arm in the same column, is the top-left
 * quadrant all one level — and none of those is answerable from a sorted list of 96 rows. So this
 * draws the grid.
 *
 * Three things here are less obvious than they look.
 *
 * **The layout's own row/column origin is not assumed.** Nothing on the wire says whether `row` is
 * 0-based or 1-based, and both conventions exist in plate tooling. The span is therefore derived
 * from the wells present rather than declared: the origin is whichever of 0 or 1 the smallest
 * observed index is consistent with, and the drawn extent is widened past `rows`/`columns`
 * whenever a well sits outside them. A well the declared size does not cover is a defect in the
 * layout, and drawing it where it says it is beats dropping it silently.
 *
 * **A control is not a colour.** Controls are marked by a ring, a dot and their own text, so the
 * distinction survives greyscale, both themes and a reader who cannot tell the tones apart. Colour
 * alone would be the only signal for the one thing on this grid that is not being screened.
 *
 * **It scrolls itself.** A 1536-well plate is 48 columns wide and no viewport holds that, so the
 * grid owns an `overflow-x-auto` region with a real focusable role — a scroller nothing inside can
 * focus is a set of columns no keyboard can reach — and the page around it never scrolls sideways.
 */

import type { PlateLayout, ProtocolArm, Well } from '../../shared/protocols.ts';
import { cn } from '@/lib/utils';

/** `A`, `B`, … `Z`, `AA`, … — a 1536 plate has 32 rows, so the two-letter case is real. */
export function rowLabel(index: number): string {
  let out = '';
  let n = index;
  while (n >= 0) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out;
}

/**
 * The range of indices to draw on one axis.
 *
 * `declared` is what the layout says; `observed` is every index a well actually claims. The result
 * covers both, because the two disagreeing is exactly the case a reader needs to see.
 */
export function axisSpan(declared: number, observed: number[]): { origin: number; count: number } {
  if (observed.length === 0) return { origin: 1, count: Math.max(declared, 0) };
  const min = Math.min(...observed);
  const max = Math.max(...observed);
  // A negative index is not a convention, it is a broken layout — clamped to 0 so the grid still
  // draws rather than allocating an unbounded number of cells.
  const origin = min <= 0 ? Math.max(min, 0) : 1;
  return { origin, count: Math.max(declared, max - origin + 1) };
}

/** The arm ids that are controls, and what kind — the one thing `Well` does not carry. */
function controlsOf(arms: ProtocolArm[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const arm of arms) {
    if (arm.control) out.set(arm.arm_id, arm.control);
  }
  return out;
}

function WellCell({
  well,
  control,
}: {
  well: Well | undefined;
  control: string;
}): React.JSX.Element {
  if (!well) {
    return (
      <td className="p-0.5">
        {/* Muted and empty, never a dash: an unused well is not a value, and a glyph in it would
            read as one at a glance across 96 cells. */}
        <div className="h-11 w-16 rounded-md border border-dashed border-border-subtle bg-surface-sunken/60" />
      </td>
    );
  }
  return (
    <td className="p-0.5">
      <div
        // The label is what a chemist reads off the plate itself, so it is the cell's accessible
        // name even though the visible text is the arm.
        title={`${well.label} · ${well.arm_id}${control ? ` · ${control} control` : ''}`}
        className={cn(
          'flex h-11 w-16 flex-col justify-center gap-0.5 rounded-md border px-1.5 py-1',
          control
            ? 'border-brand/60 bg-brand-soft ring-1 ring-brand/40'
            : 'border-border-subtle bg-surface-raised',
        )}
      >
        <span
          className={cn(
            'flex items-center gap-1 truncate font-mono text-2xs',
            control ? 'text-brand-ink' : 'text-ink',
          )}
        >
          {control && <span aria-hidden>●</span>}
          <span className="truncate">{well.arm_id}</span>
        </span>
        <span className={cn('text-2xs', control ? 'text-brand-ink' : 'text-ink-subtle')}>
          {control ? control : `run ${well.run_order}`}
        </span>
      </div>
    </td>
  );
}

export function PlateMap({
  layout,
  arms = [],
}: {
  layout: PlateLayout;
  /** Only for the control marking — a `Well` does not say whether its arm is one. */
  arms?: ProtocolArm[];
}): React.JSX.Element {
  const controls = controlsOf(arms);
  const wells = layout.wells;
  const rowSpan = axisSpan(
    layout.rows,
    wells.map((w) => w.row),
  );
  const columnSpan = axisSpan(
    layout.columns,
    wells.map((w) => w.column),
  );

  const byPosition = new Map<string, Well>();
  for (const well of wells) byPosition.set(`${well.row}:${well.column}`, well);

  const rowIndices = Array.from({ length: rowSpan.count }, (_, i) => rowSpan.origin + i);
  const columnIndices = Array.from({ length: columnSpan.count }, (_, i) => columnSpan.origin + i);
  const controlCount = wells.filter((w) => controls.has(w.arm_id)).length;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-ink-muted">
        {layout.plate_format}-well plate · {rowSpan.count} × {columnSpan.count} · {wells.length}{' '}
        occupied
        {controlCount > 0 && ` · ${controlCount} control${controlCount === 1 ? '' : 's'}`}
        {/* Whether the order can be reproduced, not just whether it was shuffled. A randomised
            layout with no seed is one nobody can lay out again, and that is a fact about the
            experiment rather than about this drawing. */}
        {layout.randomized
          ? layout.seed === null
            ? ' · run order randomised, no seed recorded — this layout cannot be reproduced'
            : ` · run order randomised, seed ${layout.seed}`
          : ' · run order as designed'}
      </p>

      <div
        tabIndex={0}
        role="region"
        aria-label={`Plate map, ${rowSpan.count} rows by ${columnSpan.count} columns`}
        className="overflow-x-auto rounded-lg border border-border-subtle bg-surface p-2 focus-ring"
      >
        <table className="border-separate border-spacing-0">
          <thead>
            <tr>
              {/* The corner. `scope` is deliberately absent — it heads neither a row nor a
                  column, and claiming either would give every cell a second wrong header. */}
              <th className="sticky left-0 z-10 bg-surface px-1 py-1">
                <span className="sr-only-live">Row</span>
              </th>
              {columnIndices.map((column, columnIndex) => (
                <th
                  key={column}
                  scope="col"
                  className="px-1 py-1 text-center text-2xs font-medium text-ink-subtle"
                >
                  {/* The header is the cell's **position in the drawn grid**, not its index, which
                      is the same rule the row letters have always used (`rowLabel(rowIndex)`).
                      `place()` emits a 0-based index and writes the label as
                      `row_label(row) + str(column + 1)`, so drawing the raw index put well `A1`
                      under a header reading `0` and left a 24-well plate with no column 6 —
                      invisible because every fixture here declared a 1-based origin the producer
                      cannot emit. Position rather than `column + 1` because `axisSpan` returns an
                      origin of 0 *or* 1, and the value rule is right for only one of them: a
                      1-based layout numbered its columns 2..7 while its rows still read A..D. */}
                  {columnIndex + 1}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowIndices.map((row, rowIndex) => (
              <tr key={row}>
                {/* Sticky, so the row letter stays readable while a 48-column plate is scrolled —
                    the one piece of the grid that is useless off-screen. */}
                <th
                  scope="row"
                  className="sticky left-0 z-10 bg-surface px-1.5 py-1 text-2xs font-medium text-ink-subtle"
                >
                  {rowLabel(rowIndex)}
                </th>
                {columnIndices.map((column) => (
                  <WellCell
                    key={column}
                    well={byPosition.get(`${row}:${column}`)}
                    control={controls.get(byPosition.get(`${row}:${column}`)?.arm_id ?? '') ?? ''}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
