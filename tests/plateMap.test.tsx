/**
 * The plate is a grid, and the grid is the reading.
 *
 * A layout read as a list of wells cannot answer the question a chemist asks of it — is the
 * positive control on the edge, did the randomiser put both replicates in one column — so what is
 * pinned here is that the cells land where the layout says they do, that a control is marked by
 * something other than a colour, and that nothing is dropped on the way.
 *
 * Two of these cover cases nothing on the wire disambiguates. **The row/column origin** is not
 * stated anywhere in `PlateLayout`, and both 0-based and 1-based conventions exist in plate
 * tooling; drawing a 1-based layout as though it were 0-based silently loses its last row. And a
 * well **outside** the declared `rows`/`columns` is a defect in the layout, which the map draws
 * rather than hides: an arm that vanished from the plate map is an arm nobody runs.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { PlateMap, axisSpan, rowLabel } from '../src/components/PlateMap.tsx';
import type { PlateLayout, ProtocolArm, Well } from '../shared/protocols.ts';

afterEach(cleanup);

const well = (over: Partial<Well> & Pick<Well, 'label' | 'row' | 'column'>): Well => ({
  arm_id: 'A1',
  run_order: 1,
  ...over,
});

/**
 * Annotated with the interface the service is declared to return rather than left as a literal, so
 * `tsc -b` — already a CI step — is the drift check on this fixture.
 */
const layout = (over: Partial<PlateLayout> = {}): PlateLayout => ({
  // A real format: `PLATE_SHAPES[24]` is 4x6, and `place()` writes 0-based row/column with
  // `label = row_label(row) + str(column + 1)`. This said `96, rows: 2, columns: 3` with
  // 1-based wells — a shape the producer cannot emit, and the reason the map's 0-based column
  // headers read correctly here while showing `0` against well `A1` in the real app.
  plate_format: 24,
  rows: 4,
  columns: 6,
  randomized: false,
  seed: null,
  wells: [
    well({ label: 'A1', row: 0, column: 0, arm_id: 'arm-1', run_order: 3 }),
    well({ label: 'A2', row: 0, column: 1, arm_id: 'arm-2', run_order: 1 }),
    well({ label: 'B3', row: 1, column: 2, arm_id: 'arm-ctl', run_order: 2 }),
  ],
  ...over,
});

const arm = (id: string, control: ProtocolArm['control']): ProtocolArm => ({
  arm_id: id,
  levels: {},
  setpoints: null,
  control,
  replicate_of: '',
  note: '',
});

describe('rowLabel', () => {
  it('runs past Z, because a 1536-well plate has 32 rows', () => {
    expect(rowLabel(0)).toBe('A');
    expect(rowLabel(25)).toBe('Z');
    expect(rowLabel(26)).toBe('AA');
    expect(rowLabel(31)).toBe('AF');
  });
});

describe('axisSpan', () => {
  it('reads the origin off the wells rather than assuming one', () => {
    // Nothing on the wire says whether `row` counts from 0 or from 1.
    expect(axisSpan(2, [1, 2])).toEqual({ origin: 1, count: 2 });
    expect(axisSpan(2, [0, 1])).toEqual({ origin: 0, count: 2 });
  });

  it('widens past the declared size rather than dropping a well outside it', () => {
    // A well the declared extent does not cover is a broken layout. Drawing it where it says it is
    // beats an arm silently missing from the plate.
    expect(axisSpan(2, [1, 2, 4])).toEqual({ origin: 1, count: 4 });
  });

  it('falls back to the declared size when there are no wells at all', () => {
    expect(axisSpan(3, [])).toEqual({ origin: 1, count: 3 });
  });
});

describe('PlateMap', () => {
  it('draws rows × columns with labels down the side and across the top', () => {
    render(<PlateMap layout={layout()} />);

    const grid = screen.getByRole('region', { name: /Plate map, 4 rows by 6 columns/ });
    const table = within(grid).getByRole('table');
    // Four body rows plus the header row — a 24-well plate is 4x6, which is what the fixture now
    // declares. The columns are 1..6: `place()` emits a 0-based index and labels well `A1` as
    // column 0, so a header showing the raw index put `A1` under `0` and left no column 6.
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    expect(within(table).getByRole('rowheader', { name: 'A' })).toBeTruthy();
    expect(within(table).getByRole('rowheader', { name: 'B' })).toBeTruthy();
    expect(within(table).queryByRole('columnheader', { name: '0' })).toBeNull();
    for (const column of ['1', '2', '3', '4', '5', '6']) {
      expect(within(table).getByRole('columnheader', { name: column })).toBeTruthy();
    }
  });

  it('shows each occupied well’s arm and its run order', () => {
    render(<PlateMap layout={layout()} />);
    expect(screen.getByText('arm-1')).toBeTruthy();
    // The run order, not the well index: the order is what a bench works through, and on a
    // randomised plate it is deliberately not the reading order.
    expect(screen.getByText('run 3')).toBeTruthy();
    expect(screen.getByText('run 1')).toBeTruthy();
  });

  it('marks a control by more than a colour', () => {
    // Colour alone would be the only signal for the one thing on the grid that is not being
    // screened — and it is the first thing to go in greyscale, in a photograph of a screen, or for
    // a reader who cannot tell the tones apart.
    render(<PlateMap layout={layout()} arms={[arm('arm-ctl', 'positive'), arm('arm-1', '')]} />);
    expect(screen.getByText('positive')).toBeTruthy();
    expect(screen.getByTitle(/arm-ctl · positive control/)).toBeTruthy();
    // And the arm beside it is not marked, which is what makes the marking mean something.
    expect(screen.getByTitle('A1 · arm-1')).toBeTruthy();
  });

  it('leaves an unused well empty rather than putting a value in it', () => {
    // 24 cells, 3 occupied. A glyph in the other 21 would read as data across 96 of them.
    const { container } = render(<PlateMap layout={layout()} />);
    expect(container.querySelectorAll('td')).toHaveLength(24);
    expect(container.querySelectorAll('td .border-dashed')).toHaveLength(21);
  });

  it('draws a 0-based layout without losing its last row', () => {
    render(
      <PlateMap
        layout={layout({
          rows: 2,
          columns: 2,
          wells: [
            well({ label: 'A1', row: 0, column: 0, arm_id: 'zero' }),
            well({ label: 'B2', row: 1, column: 1, arm_id: 'one' }),
          ],
        })}
      />,
    );
    expect(screen.getByText('zero')).toBeTruthy();
    expect(screen.getByText('one')).toBeTruthy();
  });

  it('numbers the columns the way it letters the rows, whatever origin the layout arrives on', () => {
    // `axisSpan` returns an origin of 0 or 1, and the two axes used different rules: rows go by
    // their position in the drawn grid, columns went by the index + 1. On a 1-based layout — one
    // this producer cannot emit, which is exactly why no fixture caught it — that read A..B down
    // the side and 2..3 across the top, so the cell labelled `A1` sat under a header saying `2`.
    render(
      <PlateMap
        layout={layout({
          rows: 2,
          columns: 2,
          wells: [
            well({ label: 'A1', row: 1, column: 1, arm_id: 'one-based' }),
            well({ label: 'B2', row: 2, column: 2, arm_id: 'other' }),
          ],
        })}
      />,
    );
    const table = screen.getByRole('table');
    expect(within(table).getByRole('rowheader', { name: 'A' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: '1' })).toBeTruthy();
    expect(within(table).queryByRole('columnheader', { name: '3' })).toBeNull();
  });

  it('says whether the run order can be reproduced, not just whether it was shuffled', () => {
    // A randomised layout with no seed is one nobody can lay out again — a fact about the
    // experiment rather than about this drawing.
    const { rerender } = render(<PlateMap layout={layout({ randomized: true, seed: null })} />);
    expect(screen.getByText(/cannot be reproduced/)).toBeTruthy();

    rerender(<PlateMap layout={layout({ randomized: true, seed: 42 })} />);
    expect(screen.getByText(/seed 42/)).toBeTruthy();
  });

  it('scrolls inside its own focusable region, so a wide plate never scrolls the page', () => {
    // 1536 wells is 48 columns and no viewport holds that. A scroller nothing inside it can focus
    // is a set of columns no keyboard can ever reach — the defect `axe` found on the trace panel's
    // <pre> blocks the first time a real payload overflowed one.
    render(<PlateMap layout={layout({ plate_format: 1536, rows: 32, columns: 48 })} />);
    const region = screen.getByRole('region', { name: /Plate map/ });
    expect(region.className).toContain('overflow-x-auto');
    expect(region.getAttribute('tabindex')).toBe('0');
  });
});
