/**
 * Bound values (artefacts wave 3): what the wire carries, what a view marks, and what a write keeps.
 *
 * The defect this file exists to prevent is quiet: an edit built from the *resolved* spec posts
 * every binding it did not touch back as the literal it resolved to. The revision is accepted, the
 * numbers on screen do not move, and every provenance marker in the artefact disappears — a table
 * that was the tool's output becomes a table the chemist typed. So the assertions are on the
 * posted body, binding by binding, including a field inside `$bind` this build does not know.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TableView } from '../src/components/exhibits/views/TableView.tsx';
import {
  ChartView,
  TRANSCRIBED_CAPTION,
  transcribedCaption,
} from '../src/components/exhibits/views/ChartView.tsx';
import { StructuresView } from '../src/components/exhibits/views/StructuresView.tsx';
import { GoneSourcesStrip, SOURCE_GONE } from '../src/components/exhibits/Provenance.tsx';
import { detach, transcribedSeries } from '../src/components/exhibits/bindings.ts';
import { useExhibitPane } from '../src/state/exhibitPane.ts';
import {
  decodeExhibitDiff,
  decodeExhibitView,
  isSpec,
  type ChartSpec,
  type ExhibitView,
  type RawExhibitSpec,
  type StructuresSpec,
  type TableSpec,
} from '../shared/exhibits.ts';
import { stubFetch } from './helpers.ts';
import { VIEW } from './exhibitFixtures.ts';

vi.mock('../src/auth/AuthContext.tsx', () => {
  const value = { auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true };
  return { useAuth: () => value, useIsReviewer: () => true };
});

const SID = 'a'.repeat(32);
const REF = '3b'.repeat(32);
const GONE = '4c'.repeat(32);

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A binding as the service stores it — with a field this build does not know, to be kept. */
const bound = (result: string, pointer: string) => ({
  $bind: { result, pointer, resolved_at: '2026-10-03' },
});

const COLUMNS = [
  { key: 'solvent', label: 'Solvent', unit: '' },
  { key: 'yield', label: 'Yield', unit: '%' },
];

/** A table with one live binding, one whose source is gone, and one literal. */
const TABLE_BODY = {
  ...VIEW,
  revision: 2,
  head_revision: 2,
  author_kind: 'agent',
  spec: {
    kind: 'table',
    columns: COLUMNS,
    rows: [
      { solvent: '2-MeTHF', yield: 82 },
      { solvent: 'CPME', yield: null },
      { solvent: 'Toluene', yield: 51 },
    ],
  },
  raw_spec: {
    kind: 'table',
    columns: COLUMNS,
    rows: [
      { solvent: '2-MeTHF', yield: bound(REF, '/0/yield') },
      { solvent: 'CPME', yield: bound(GONE, '/1/yield') },
      { solvent: 'Toluene', yield: 51 },
    ],
  },
  bindings: [
    {
      path: 'rows[0].yield',
      result_ref: REF,
      tool: 'predict_yield',
      pointer: '/0/yield',
      ok: true,
      error: '',
    },
    {
      path: 'rows[1].yield',
      result_ref: GONE,
      tool: 'predict_yield',
      pointer: '/1/yield',
      ok: false,
      error: 'removed by retention',
    },
  ],
  unverified_figures: [],
};

const table = decodeExhibitView(TABLE_BODY) as ExhibitView & { spec: TableSpec };

let restore: (() => void) | null = null;
beforeEach(() => useExhibitPane.setState({ focus: {} }));
afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

/** The JSON bodies POSTed so far. */
const posted = (calls: { init?: RequestInit }[]) =>
  calls
    .filter((c) => c.init?.method === 'POST')
    .map(
      (c) =>
        JSON.parse(String(c.init?.body)) as {
          parent_revision: number;
          spec: Record<string, unknown>;
          change_note: string;
        },
    );

describe('the wire', () => {
  it('mirrors raw_spec and bindings[], and keeps a $bind field it does not know', () => {
    expect(table.spec.rows[0]).toEqual({ solvent: '2-MeTHF', yield: 82 });
    expect(table.raw_spec).toEqual(TABLE_BODY.raw_spec);
    expect(table.bindings).toEqual(TABLE_BODY.bindings);
  });

  it('reads a service that predates raw_spec as having stored what it drew', () => {
    const { raw_spec: _raw, bindings: _b, ...old } = TABLE_BODY;
    const view = decodeExhibitView({ ...old, spec: VIEW.spec });
    expect(view.raw_spec).toEqual(view.spec);
    expect(view.bindings).toEqual([]);
  });

  it('takes $bind only in the stored spec, and a gone binding’s null only in the drawn one', () => {
    expect(isSpec(TABLE_BODY.raw_spec)).toBe(true);
    // A binding in the resolved spec is not something the service sends: unreadable, not coerced.
    expect(decodeExhibitView({ ...TABLE_BODY, spec: TABLE_BODY.raw_spec }).spec).toBeNull();
    // A series whose source is gone resolved to `null`: no points, not an unreadable chart.
    const chart = decodeExhibitView({
      ...TABLE_BODY,
      kind: 'chart',
      spec: {
        kind: 'chart',
        chart: 'line',
        x_label: 't',
        y_label: 'c',
        series: [{ name: 'A', x: null, y: null }],
      },
      raw_spec: null,
    });
    expect(chart.spec).toEqual(expect.objectContaining({ series: [{ name: 'A', x: [], y: [] }] }));
    // The two table bodies are exclusive — but an *empty* `rows` beside `rows_from` is how the
    // service serialises a whole-table binding (its `rows` is a defaulted field), so that is read.
    const rowsFrom = { result: REF, pointer: '/rows', columns: { yield: '/y' } };
    expect(isSpec({ kind: 'table', columns: COLUMNS, rows: [], rows_from: rowsFrom })).toBe(true);
    expect(
      isSpec({ kind: 'table', columns: COLUMNS, rows: [{ yield: 1 }], rows_from: rowsFrom }),
    ).toBe(false);
  });

  it('shows a binding in the service’s diff as what it points at, not as its JSON', () => {
    const diff = decodeExhibitDiff({
      from_revision: 1,
      to_revision: 2,
      changes: [
        { path: 'rows[0].yield', kind: 'changed', before: bound(REF, '/0/yield'), after: 82 },
      ],
    });
    expect(diff.changes[0]).toEqual({
      path: 'rows[0].yield',
      kind: 'changed',
      before: `linked to r:${REF.slice(0, 12)} /0/yield`,
      after: '82',
    });
  });
});

describe('a table with bound cells', () => {
  it('marks a bound cell with its tool and pointer, and offers no edit on it', () => {
    render(<TableView sessionId={SID} view={table} spec={table.spec} isHead />);
    const marker = screen.getByRole('button', { name: 'From predict_yield, /0/yield' });
    expect(marker.closest('td')?.textContent).toContain('82');
    expect(screen.queryByRole('button', { name: /^Edit Yield \(%\), row 1/ })).toBeNull();
    // The literal row is still a chemist's to correct.
    expect(screen.getByRole('button', { name: 'Edit Yield (%), row 3: 51' })).toBeTruthy();
  });

  it('says a gone source in the cell, in the marker’s name, and in the strip', () => {
    render(<TableView sessionId={SID} view={table} spec={table.spec} isHead />);
    const marker = screen.getByRole('button', {
      name: `From predict_yield, /1/yield — ${SOURCE_GONE}`,
    });
    expect(marker.closest('td')?.textContent).toContain(SOURCE_GONE);
    cleanup();
    render(<GoneSourcesStrip gone={table.bindings.filter((b) => !b.ok)} />);
    expect(screen.getByRole('note').textContent).toContain('rows[1].yield');
  });

  it('opens the provenance from the keyboard-reachable marker', async () => {
    render(<TableView sessionId={SID} view={table} spec={table.spec} isHead />);
    const marker = screen.getByRole('button', { name: 'From predict_yield, /0/yield' });
    expect(marker.tagName).toBe('BUTTON');
    fireEvent.click(marker);
    const popover = await screen.findByRole('dialog', { name: 'Where this value came from' });
    expect(popover.textContent).toContain('predict_yield');
    expect(popover.textContent).toContain('/0/yield');
    expect(popover.textContent).toContain(`r:${REF.slice(0, 12)}`);
  });

  it('posts an edit of a literal cell with every untouched binding verbatim', async () => {
    const stub = stubFetch(() => json(201, { ...TABLE_BODY, revision: 3, head_revision: 3 }));
    restore = stub.restore;
    render(<TableView sessionId={SID} view={table} spec={table.spec} isHead />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Yield (%), row 3: 51' }));
    const input = screen.getByRole('textbox', { name: 'Yield (%), row 3' });
    fireEvent.change(input, { target: { value: '55' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(posted(stub.calls)).toHaveLength(1));
    const [body] = posted(stub.calls);
    expect(body?.parent_revision).toBe(2);
    expect(body?.spec.rows).toEqual([
      { solvent: '2-MeTHF', yield: bound(REF, '/0/yield') },
      { solvent: 'CPME', yield: bound(GONE, '/1/yield') },
      { solvent: 'Toluene', yield: 55 },
    ]);
  });

  it('detaches one binding into the literal shown, on the revision the popover opened over', async () => {
    const stub = stubFetch(() => json(201, { ...TABLE_BODY, revision: 4, head_revision: 4 }));
    restore = stub.restore;
    const { rerender } = render(
      <TableView sessionId={SID} view={table} spec={table.spec} isHead />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'From predict_yield, /0/yield' }));
    const popover = await screen.findByRole('dialog', { name: 'Where this value came from' });
    // The head refetched under the open popover (an agent revision landed as r3).
    rerender(
      <TableView
        sessionId={SID}
        view={{ ...table, revision: 3, head_revision: 3 }}
        spec={table.spec}
        isHead
      />,
    );
    fireEvent.click(within(popover).getByRole('button', { name: 'Detach' }));
    await waitFor(() => expect(posted(stub.calls)).toHaveLength(1));
    const [body] = posted(stub.calls);
    // Parent = the base the edit started from, so a moved head is a 409, not a silent overwrite.
    expect(body?.parent_revision).toBe(2);
    expect(body?.change_note).toBe('Detached rows[0].yield from its tool result');
    expect(body?.spec.rows).toEqual([
      { solvent: '2-MeTHF', yield: 82 },
      { solvent: 'CPME', yield: bound(GONE, '/1/yield') },
      { solvent: 'Toluene', yield: 51 },
    ]);
  });

  it('offers no detach on an earlier revision', async () => {
    render(<TableView sessionId={SID} view={table} spec={table.spec} isHead={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'From predict_yield, /0/yield' }));
    const popover = await screen.findByRole('dialog', { name: 'Where this value came from' });
    expect(within(popover).queryByRole('button', { name: 'Detach' })).toBeNull();
  });

  it('reads a table bound whole as read-only, and detaches it into rows', async () => {
    const whole = decodeExhibitView({
      ...TABLE_BODY,
      // The service's own serialisation: `rows` is a defaulted field, so it is sent, empty.
      raw_spec: {
        kind: 'table',
        columns: COLUMNS,
        rows: [],
        rows_from: { result: REF, pointer: '/screen', columns: { solvent: '/s', yield: '/y' } },
      },
      bindings: [
        { path: 'rows_from', result_ref: REF, tool: 'screen', pointer: '/screen', ok: true },
      ],
    }) as ExhibitView & { spec: TableSpec };
    expect(whole.raw_spec).not.toBeNull();
    const stub = stubFetch(() => json(201, { ...TABLE_BODY, revision: 3, head_revision: 3 }));
    restore = stub.restore;
    render(<TableView sessionId={SID} view={whole} spec={whole.spec} isHead />);
    expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'From screen, /screen' }));
    const popover = await screen.findByRole('dialog', { name: 'Where this value came from' });
    fireEvent.click(within(popover).getByRole('button', { name: 'Detach' }));
    await waitFor(() => expect(posted(stub.calls)).toHaveLength(1));
    const [body] = posted(stub.calls);
    expect(body?.spec).toEqual({
      kind: 'table',
      columns: COLUMNS,
      rows: [
        { solvent: '2-MeTHF', yield: 82 },
        { solvent: 'CPME', yield: null },
        { solvent: 'Toluene', yield: 51 },
      ],
    });
  });
});

describe('a chart with bound series', () => {
  const resolved: ChartSpec = {
    kind: 'chart',
    chart: 'line',
    x_label: 'Time (h)',
    y_label: 'Conversion (%)',
    series: [
      { name: 'Measured', x: [0, 2, 4], y: [0, 41, 77] },
      { name: 'Literature', x: [0, 2, 4], y: [0, 35, 70] },
    ],
  };
  const chartView = (series: unknown[], bindings: unknown[] = []) =>
    decodeExhibitView({
      ...TABLE_BODY,
      kind: 'chart',
      spec: resolved,
      raw_spec: { ...resolved, series },
      bindings,
    }) as ExhibitView & { spec: ChartSpec };
  const measured = { name: 'Measured', x: bound(REF, '/t'), y: bound(REF, '/c') };
  const literature = { name: 'Literature', x: bound(REF, '/t'), y: bound(REF, '/lit') };

  it('drops the caption when every series is linked', () => {
    const view = chartView([measured, literature]);
    render(<ChartView sessionId={SID} view={view} spec={view.spec} isHead />);
    expect(screen.queryByText(/transcribed by the agent/)).toBeNull();
    expect(screen.getAllByRole('button', { name: /^From a tool result, \// })).toHaveLength(4);
  });

  it('names the transcribed series when only some are linked', () => {
    const view = chartView([measured, resolved.series[1]]);
    render(<ChartView sessionId={SID} view={view} spec={view.spec} isHead />);
    expect(
      screen.getByText(
        'Values of “Literature” transcribed by the agent — not linked to tool results. The other series are linked.',
      ),
    ).toBeTruthy();
    // The rows of the linked series say so to a screen reader; the transcribed rows do not.
    expect(screen.getAllByText('(linked to a tool result)')).toHaveLength(3);
  });

  it('keeps the contract’s caption when nothing is linked', () => {
    expect(transcribedCaption(['A', 'B'], 2)).toBe(TRANSCRIBED_CAPTION);
    expect(transcribedCaption([], 2)).toBeNull();
    // A bar chart's category names are labels, not figures: a bound y is enough.
    expect(
      transcribedSeries(
        {
          kind: 'chart',
          chart: 'bar',
          x_label: '',
          y_label: '',
          series: [{ name: 'Y', x: ['a', 'b'], y: bound(REF, '/y') }],
        },
        {
          kind: 'chart',
          chart: 'bar',
          x_label: '',
          y_label: '',
          series: [{ name: 'Y', x: ['a', 'b'], y: [1, 2] }],
        },
      ),
    ).toEqual([]);
  });

  it('takes the caption off only the series a person detached', async () => {
    // r1 (agent): Measured bound, Literature literal. r2 (a person): Measured detached. The agent
    // still transcribed Literature; Measured holds the tool's values verbatim.
    const agentRaw = { ...resolved, series: [measured, resolved.series[1]!] } as RawExhibitSpec;
    const stub = stubFetch((url) =>
      url.endsWith('/revisions')
        ? json(200, {
            revisions: [
              { revision: 1, parent_revision: 0, author_kind: 'agent', author: 'chemclaw' },
              { revision: 2, parent_revision: 1, author_kind: 'human', author: 'me' },
            ],
          })
        : json(200, {
            ...TABLE_BODY,
            kind: 'chart',
            revision: 1,
            spec: resolved,
            raw_spec: agentRaw,
          }),
    );
    restore = stub.restore;
    const view = decodeExhibitView({
      ...TABLE_BODY,
      exhibit_id: 'xb-0000000000de7ac4',
      kind: 'chart',
      author_kind: 'human',
      spec: resolved,
      raw_spec: resolved,
      bindings: [],
    }) as ExhibitView & { spec: ChartSpec };
    render(<ChartView sessionId={SID} view={view} spec={view.spec} isHead />);
    expect(
      await screen.findByText(
        'Values of “Literature” transcribed by the agent — not linked to tool results. The other series are linked.',
      ),
    ).toBeTruthy();
    // And the rule itself, without the network: literal now, linked in the agent's revision.
    expect(transcribedSeries(view.raw_spec, resolved, agentRaw)).toEqual(['Literature']);
    expect(transcribedSeries(view.raw_spec, resolved, null)).toEqual([]);
    expect(transcribedSeries(view.raw_spec, resolved, undefined)).toEqual([
      'Measured',
      'Literature',
    ]);
  });

  it('offers no detach for a series whose source is gone — there is nothing to keep', async () => {
    const view = chartView(
      [{ name: 'Measured', x: [0, 2, 4], y: bound(GONE, '/c') }, resolved.series[1]],
      [{ path: 'series[0].y', result_ref: GONE, tool: 'hplc', pointer: '/c', ok: false }],
    );
    render(<ChartView sessionId={SID} view={view} spec={view.spec} isHead />);
    expect(screen.getByText(SOURCE_GONE)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `From hplc, /c — ${SOURCE_GONE}` }));
    const popover = await screen.findByRole('dialog', { name: 'Where this value came from' });
    expect(within(popover).queryByRole('button', { name: 'Detach' })).toBeNull();
  });
});

describe('structures with bound properties', () => {
  it('marks a bound property and detaches it into its value, leaving the SMILES binding', async () => {
    const resolved: StructuresSpec = {
      kind: 'structures',
      items: [{ smiles: 'CCO', label: 'ethanol', props: { logP: -0.31, note: 'solvent' } }],
    };
    const view = decodeExhibitView({
      ...TABLE_BODY,
      kind: 'structures',
      spec: resolved,
      raw_spec: {
        kind: 'structures',
        items: [
          {
            smiles: bound(REF, '/smiles'),
            label: 'ethanol',
            props: { logP: bound(REF, '/logp'), note: 'solvent' },
          },
        ],
      },
      bindings: [
        { path: 'items[0].props.logP', result_ref: REF, tool: 'props', pointer: '/logp', ok: true },
      ],
    }) as ExhibitView & { spec: StructuresSpec };
    const stub = stubFetch(() => json(201, { ...TABLE_BODY, revision: 3, head_revision: 3 }));
    restore = stub.restore;
    render(<StructuresView sessionId={SID} view={view} spec={view.spec} isHead />);
    fireEvent.click(screen.getByRole('button', { name: 'From props, /logp' }));
    const popover = await screen.findByRole('dialog', { name: 'Where this value came from' });
    fireEvent.click(within(popover).getByRole('button', { name: 'Detach' }));
    await waitFor(() => expect(posted(stub.calls)).toHaveLength(1));
    expect(posted(stub.calls)[0]?.spec).toEqual({
      kind: 'structures',
      items: [
        {
          smiles: bound(REF, '/smiles'),
          label: 'ethanol',
          props: { logP: -0.31, note: 'solvent' },
        },
      ],
    });
  });

  it('refuses to detach a value that is not there', () => {
    const raw = {
      kind: 'structures' as const,
      items: [{ smiles: 'CCO', label: '', props: { logP: bound(GONE, '/logp') } }],
    };
    const resolved: StructuresSpec = {
      kind: 'structures',
      items: [{ smiles: 'CCO', label: '', props: { logP: null } }],
    };
    expect(detach(raw, resolved, { at: 'prop', item: 0, name: 'logP' })).toBeNull();
  });
});
