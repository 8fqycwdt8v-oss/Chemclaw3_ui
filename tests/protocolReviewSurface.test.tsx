/**
 * Four claims the review surfaces make about a document, each of which was false.
 *
 * The diff is the record of what an expert changed, the plate map is what a chemist reads a well
 * id off, and the receipt card is the first thing either of them sees. A badge that contradicts
 * its own row, a green "checks passed" over checks nobody ran, and a well id no screen reader can
 * reach are all the same failure: a surface asserting more than the service said.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RevisionDiff } from '../src/components/RevisionDiff.tsx';
import { PlateMap } from '../src/components/PlateMap.tsx';
import { rendererFor } from '../src/results/renderers.tsx';
import type { DesignDiff, PlateLayout } from '../shared/protocols.ts';

afterEach(() => cleanup());

function diffOf(changes: DesignDiff['changes']): DesignDiff {
  return { from_revision: 1, to_revision: 2, changes };
}

describe('the revision diff', () => {
  it('does not call an added-but-empty value "removed"', () => {
    // `flatten` keeps `''` leaves, so a charge line added with an empty note is ordinary output.
    render(
      <RevisionDiff
        diff={diffOf([{ path: 'base.charge.toluene.note', kind: 'added', before: '', after: '' }])}
      />,
    );
    expect(screen.getByText('added')).toBeTruthy();
    expect(screen.queryByText('removed')).toBeNull();
  });

  it('does not call a field that existed and was empty "not present"', () => {
    render(
      <RevisionDiff
        diff={diffOf([
          { path: 'base.setpoints.solvent', kind: 'changed', before: '', after: 'MeCN' },
        ])}
      />,
    );
    expect(screen.getByText('changed')).toBeTruthy();
    expect(screen.queryByText('not present')).toBeNull();
  });
});

describe('the plate map', () => {
  it('gives each well cell the well id as its accessible name', () => {
    const layout: PlateLayout = {
      plate_format: 24,
      rows: 4,
      columns: 6,
      randomized: false,
      seed: null,
      wells: [{ arm_id: 'arm-1', label: 'A1', row: 0, column: 0, run_order: 1 }],
    };
    render(<PlateMap layout={layout} arms={[]} />);
    // `title` on a non-interactive div inside the cell contributes nothing to the cell's name.
    expect(screen.getByRole('cell', { name: /A1/ })).toBeTruthy();
  });
});

describe('the receipt card', () => {
  it('does not report the request stage’s "not checked yet" notes as passes', () => {
    const data = {
      design_id: 'design-000000000001',
      revision: 1,
      title: 'Amination',
      mode: 'screen',
      status: 'requested',
      summary: 'the structured ask, no procedure yet',
      arm_count: 0,
      checks: [
        {
          check_id: 'charge_is_consistent',
          severity: 'note',
          passed: true,
          detail: 'not checked yet — this design holds only the ask',
        },
        {
          check_id: 'evidence_present',
          severity: 'note',
          passed: true,
          detail: 'not checked yet — this design holds only the ask',
        },
      ],
      blocking: [],
    };
    const found = rendererFor('structure_experiment_request', data);
    if (!found) throw new Error('no renderer');
    // The one-line verdict is what the collapsed card shows before anything is expanded.
    const verdict = found.renderer.summary?.(found.data);
    expect(verdict?.text).not.toMatch(/checks passed/);
    expect(verdict?.text).toMatch(/the procedure has not been checked/);
    expect(verdict?.tone).toBe('neutral');
  });
});
