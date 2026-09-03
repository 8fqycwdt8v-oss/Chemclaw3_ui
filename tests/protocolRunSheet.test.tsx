/**
 * The run sheet, which is the one table on this page that leaves the screen and goes to a bench.
 *
 * Three properties, each of which was false and each of which a chemist would have run:
 *
 * - **An arm override resolves against the base field by field.** `arm.setpoints ?? base` falls
 *   back only when the arm states *nothing*, so an arm changing one setpoint lost every other —
 *   the exact bug the service measured, fixed and documented in `setpoints_for`, reimplemented on
 *   the surface a chemist reads.
 * - **The rows are in run order.** The heading and the aria-label both say so; the rows were in
 *   arm order, which on a randomised plate defeats the only thing randomisation buys.
 * - **A factor named `solvent` reaches the page.** A solvent screen is the canonical HTE case, and
 *   the level column collided with the setpoint column of the same name.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ProtocolDocument } from '../src/components/ProtocolDocument.tsx';
import { stubFetch } from './helpers.ts';
import type { DesignRevision, DesignSummary, ExperimentDesign } from '../shared/protocols.ts';

vi.mock('../src/auth/AuthContext.tsx', () => {
  const value = { auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true };
  return { useAuth: () => value, useIsReviewer: () => true };
});

const DESIGN = 'design-run0000sheet';

const SUMMARY: DesignSummary = {
  design_id: DESIGN,
  title: 'Solvent screen',
  mode: 'screen',
  status: 'draft',
  project: 'PRJ-9',
  opened_by: 'chemist@example.com',
  head_revision: 1,
  arms: 2,
  blockers: 0,
  created_at: '2026-08-20T09:00:00Z',
  updated_at: '2026-08-20T09:00:00Z',
};

/** A two-arm solvent screen: A2 overrides one setpoint, and the plate runs A2 first. */
const design: ExperimentDesign = {
  request: {
    title: 'Solvent screen',
    goal: 'Get out of DMF.',
    mode: 'screen',
    reaction_smiles: '',
    components: [],
    objectives: [],
    scale: { value: '', basis: 'absent', quote: '' },
    plate_format: { value: '', basis: 'absent', quote: '' },
    max_runs: { value: '', basis: 'absent', quote: '' },
    deadline: { value: '', basis: 'absent', quote: '' },
    forbidden: [],
    prior_work: '',
    project: 'PRJ-9',
    notes: '',
  },
  base: {
    setpoints: {
      temperature_c: 80,
      time_h: 16,
      pressure_bar: null,
      atmosphere: 'N2',
      concentration_molar: 0.2,
      solvent: '2-MeTHF',
      ph: null,
    },
    charge: [],
    steps: [],
    analytics: [],
    in_process_controls: [],
    hazards: [],
    waste: '',
    expected: { yield_percent: null, selectivity: '', basis: 'assumed', detail: '' },
  },
  // The canonical HTE case, and the name that collided with the setpoint column.
  factors: [
    {
      name: 'solvent',
      kind: 'categorical',
      role: 'unknown',
      unit: '',
      levels: [
        { label: 'DMF', value: null, unit: '', smiles: '', rationale: '' },
        { label: 'MeCN', value: null, unit: '', smiles: '', rationale: '' },
      ],
    },
  ],
  arms: [
    {
      arm_id: 'A1',
      levels: { solvent: 'DMF' },
      setpoints: null,
      control: '',
      replicate_of: '',
      note: '',
    },
    {
      arm_id: 'A2',
      levels: { solvent: 'MeCN' },
      // States one field only. Everything else must come from the base.
      setpoints: {
        temperature_c: 60,
        time_h: null,
        pressure_bar: null,
        atmosphere: '',
        concentration_molar: null,
        solvent: '',
        ph: null,
      },
      control: '',
      replicate_of: '',
      note: '',
    },
  ],
  layout: {
    plate_format: 24,
    rows: 4,
    columns: 6,
    randomized: true,
    seed: 7,
    // A2 is run first — the whole point of randomising.
    wells: [
      { arm_id: 'A1', label: 'A1', row: 0, column: 0, run_order: 2 },
      { arm_id: 'A2', label: 'A2', row: 0, column: 1, run_order: 1 },
    ],
  },
  evidence: [],
};

const REVISION: DesignRevision = {
  design_id: DESIGN,
  revision: 1,
  kind: 'protocol',
  author_kind: 'agent',
  author: 'chemclaw',
  change_note: 'Drafted.',
  checks: [],
  created_at: '2026-08-20T09:00:00Z',
  design,
};

let restore: (() => void) | null = null;

beforeEach(() => {
  cleanup();
  const stub = stubFetch((url) => {
    if (url.includes('/protocols?') || url.endsWith('/protocols')) {
      return new Response(JSON.stringify({ designs: [SUMMARY] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({ ...REVISION, summary: SUMMARY, history: [], status_history: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  restore = stub.restore;
});

afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

async function runSheet(): Promise<HTMLElement> {
  render(
    <MemoryRouter initialEntries={[`/protocols/${DESIGN}`]}>
      <Routes>
        <Route path="/protocols/:designId" element={<ProtocolDocument />} />
      </Routes>
    </MemoryRouter>,
  );
  // The label sits on the scroll region that wraps the table, not on the table element.
  const region = await screen.findByRole('region', { name: /in run order/i });
  return within(region).getByRole('table');
}

/** Every cell of the body row whose first column is this arm. */
async function armCells(armId: string): Promise<(string | null)[]> {
  const table = await runSheet();
  // `slice(1)` drops the header, whose cells are `columnheader` rather than `cell`.
  const body = within(table).getAllByRole('row').slice(1);
  const row = body.find(
    (candidate) => within(candidate).getAllByRole('cell')[0]?.textContent === armId,
  );
  expect(row).toBeTruthy();
  return within(row!)
    .getAllByRole('cell')
    .map((cell) => cell.textContent);
}

describe('the run sheet', () => {
  it('resolves an arm override against the base field by field', async () => {
    // A2 states only its temperature; its time and solvent are the base's.
    const cells = await armCells('A2');
    expect(cells).toContain('60');
    // The reaction time — blank before this fix, beside rows that had one.
    expect(cells).toContain('16');
    expect(cells).toContain('2-MeTHF');
  });

  it('lists the arms in run order, as its own heading claims', async () => {
    const table = await runSheet();
    const body = within(table).getAllByRole('row').slice(1);
    const first = within(body[0]!).getAllByRole('cell')[0]?.textContent;
    expect(first).toBe('A2');
  });

  it('shows a factor named like a setpoint column instead of dropping it', async () => {
    const cells = await armCells('A1');
    // The level, which the setpoint column of the same name used to overwrite.
    expect(cells).toContain('DMF');
    // And the base solvent is still its own column, not replaced by the level.
    expect(cells).toContain('2-MeTHF');
  });
});
