/**
 * The artefact views: what each kind draws, what an edit writes, and what a stale edit does.
 *
 * The 409 is the case this file is mostly about. The agent revises artefacts as part of its
 * answers, so "it moved while I was typing" is ordinary — and the only acceptable handling is the
 * one `ProtocolEditor` holds for its own 409: say so, show what moved, and never silently re-post
 * the same edit against the new head, which would discard the other revision while telling the
 * chemist theirs succeeded. Here the service names the head, so the prompt can draw the diff at
 * once, and the retry is the chemist's click.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TableView, headerOf, parseCell } from '../src/components/exhibits/views/TableView.tsx';
import { DocumentView } from '../src/components/exhibits/views/DocumentView.tsx';
import { ChartView, TRANSCRIBED_CAPTION } from '../src/components/exhibits/views/ChartView.tsx';
import { StructuresView } from '../src/components/exhibits/views/StructuresView.tsx';
import { UnverifiedStrip, revisionLabel } from '../src/components/exhibits/ExhibitPane.tsx';
import { sdfOf } from '../src/components/exhibits/exports.ts';
import { useExhibitPane } from '../src/state/exhibitPane.ts';
import {
  decodeExhibitView,
  type ChartSpec,
  type DocumentSpec,
  type ExhibitView,
  type TableSpec,
} from '../shared/exhibits.ts';
import { stubFetch } from './helpers.ts';
import { VIEW } from './exhibitFixtures.ts';

vi.mock('../src/auth/AuthContext.tsx', () => {
  const value = { auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true };
  return { useAuth: () => value, useIsReviewer: () => true };
});

vi.mock('../src/chem/rdkit.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/chem/rdkit.ts')>()),
  // A molblock that is recognisably this test's, so the SDF assertion is about the assembly.
  molblockOf: async (smiles: string) =>
    smiles === 'not-a-molecule' ? null : `\n     RDKit          2D\n\n  1  0  0  0\nM  END\n`,
}));

const SID = 'a'.repeat(32);
const XID = VIEW.exhibit_id;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const table = decodeExhibitView(VIEW) as ExhibitView & { spec: TableSpec };

let restore: (() => void) | null = null;
beforeEach(() => useExhibitPane.setState({ focus: {} }));
afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

describe('a table artefact', () => {
  it('puts the unit in the header, never in the cell', () => {
    render(<TableView sessionId={SID} view={table} spec={table.spec} isHead />);
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent);
    expect(headers).toEqual(['Solvent', 'Yield (%)']);
    expect(headerOf({ key: 'y', label: 'Yield', unit: '%' })).toBe('Yield (%)');
    // A missing value is a dash, never a zero.
    expect(screen.getByRole('button', { name: 'Edit Yield (%), row 2: —' })).toBeTruthy();
  });

  it('sorts as a view, with missing values last in both directions', () => {
    const spec: TableSpec = {
      kind: 'table',
      columns: [{ key: 'y', label: 'Yield', unit: '%' }],
      rows: [{ y: 50 }, { y: null }, { y: 90 }, { y: 70 }],
    };
    render(<TableView sessionId={SID} view={table} spec={spec} isHead={false} />);
    const column = (): (string | null)[] =>
      screen.getAllByRole('cell').map((cell) => cell.textContent);
    const sortButton = screen.getByRole('button', { name: 'Yield (%)' });
    fireEvent.click(sortButton);
    expect(screen.getByRole('columnheader').getAttribute('aria-sort')).toBe('ascending');
    expect(column()).toEqual(['50', '70', '90', '—']);
    fireEvent.click(sortButton);
    expect(column()).toEqual(['90', '70', '50', '—']);
    fireEvent.click(sortButton);
    expect(screen.getByRole('columnheader').getAttribute('aria-sort')).toBe('none');
    expect(column()).toEqual(['50', '—', '90', '70']);
  });

  it('reads a typed cell as a number only where the column held one', () => {
    expect(parseCell(' 85 ', 82)).toBe(85);
    expect(parseCell('85', null)).toBe(85);
    expect(parseCell('', 82)).toBeNull();
    // A sample id is not a number because it looks like one.
    expect(parseCell('007', 'A-12')).toBe('007');
    expect(parseCell('n.d.', 82)).toBe('n.d.');
  });

  it('writes a corrected cell as a revision on the row clicked, once', async () => {
    const stub = stubFetch(() => json(201, { ...VIEW, revision: 3, head_revision: 3 }));
    restore = stub.restore;
    render(<TableView sessionId={SID} view={table} spec={table.spec} isHead />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Yield (%), row 1: 82' }));
    const input = screen.getByRole('textbox', { name: 'Yield (%), row 1' });
    fireEvent.change(input, { target: { value: '85' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // The input unmounting after Enter can blur it; that must not be a second revision.
    fireEvent.blur(input);

    await waitFor(() =>
      expect(stub.calls.filter((c) => c.init?.method === 'POST')).toHaveLength(1),
    );
    const posted = JSON.parse(String(stub.calls[0]?.init?.body)) as {
      parent_revision: number;
      spec: TableSpec;
      change_note: string;
    };
    expect(posted.parent_revision).toBe(2);
    expect(posted.spec.rows).toEqual([
      { solvent: '2-MeTHF', yield: 85 },
      { solvent: 'CPME', yield: null },
    ]);
    expect(posted.change_note).toBe('Edited Yield (%) in row 1');
  });

  it('meets a stale edit with what moved, and applies it on the head only when asked', async () => {
    let posts = 0;
    const stub = stubFetch((url, init) => {
      if (init?.method === 'POST') {
        posts += 1;
        return posts === 1
          ? json(409, { detail: { code: 'stale_revision', head_revision: 4 } })
          : json(201, { ...VIEW, revision: 5, head_revision: 5 });
      }
      if (url.includes('/diff')) {
        return json(200, {
          from_revision: 2,
          to_revision: 4,
          changes: [{ path: 'rows[1].yield', kind: 'changed', before: null, after: 64 }],
        });
      }
      return json(404, {});
    });
    restore = stub.restore;
    render(<TableView sessionId={SID} view={table} spec={table.spec} isHead />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Yield (%), row 1: 82' }));
    const input = screen.getByRole('textbox', { name: 'Yield (%), row 1' });
    fireEvent.change(input, { target: { value: '85' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const prompt = await screen.findByRole('alert');
    expect(prompt.textContent).toContain('revised to revision 4 after you opened revision 2');
    // The diff is your base against the head the service named — what somebody else changed.
    await within(prompt).findByText('rows[1].yield');
    expect(stub.calls.some((c) => c.url.endsWith(`/exhibits/${XID}/diff?from=2&to=4`))).toBe(true);
    // Nothing was re-posted on its own.
    expect(posts).toBe(1);

    fireEvent.click(
      within(prompt).getByRole('button', { name: 'Save my edit on top of revision 4' }),
    );
    await waitFor(() => expect(posts).toBe(2));
    const retried = stub.calls.filter((c) => c.init?.method === 'POST')[1];
    expect(JSON.parse(String(retried?.init?.body)).parent_revision).toBe(4);
  });

  it('offers no edit on an earlier revision', () => {
    render(<TableView sessionId={SID} view={table} spec={table.spec} isHead={false} />);
    expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull();
  });
});

describe('a document artefact', () => {
  const spec: DocumentSpec = { kind: 'document', markdown: '# Draft\n\nYield was **82%**.' };
  const doc = { ...table, kind: 'document', spec } as ExhibitView;

  it('names the revision the edit started on, not the one that refetched under it', async () => {
    // Review finding: the head refetching to r3 while the chemist edited r2 made the save post
    // `parent_revision: 3` — accepted, no 409, and r3's changes gone. The base is the revision the
    // editor opened on, so the service refuses and the rebase prompt runs.
    const stub = stubFetch((url, init) =>
      init?.method === 'POST'
        ? json(409, { detail: { code: 'stale_revision', head_revision: 3 } })
        : json(200, { from_revision: 2, to_revision: 3, changes: [] }),
    );
    restore = stub.restore;
    const { rerender } = render(<DocumentView sessionId={SID} view={doc} spec={spec} isHead />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Document text (Markdown)' }), {
      target: { value: 'my edit' },
    });
    // The agent revised it meanwhile; the list invalidation re-rendered the view at r3.
    const moved: DocumentSpec = { kind: 'document', markdown: '# Draft\n\nYield was 80%.' };
    rerender(
      <DocumentView
        sessionId={SID}
        view={{ ...doc, revision: 3, head_revision: 3, spec: moved } as ExhibitView}
        spec={moved}
        isHead
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save as revision 3' }));
    const prompt = await screen.findByRole('alert');
    expect(JSON.parse(String(stub.calls[0]?.init?.body)).parent_revision).toBe(2);
    expect(prompt.textContent).toContain('revised to revision 3 after you opened revision 2');
  });

  it('saves an edit as a revision, and turns a 409 into the rebase prompt with its diff', async () => {
    let posts = 0;
    const stub = stubFetch((url, init) => {
      if (init?.method === 'POST') {
        posts += 1;
        return posts === 1
          ? json(409, { detail: { code: 'stale_revision', head_revision: 3 } })
          : json(201, { ...VIEW, revision: 4 });
      }
      if (url.includes('/diff')) {
        return json(200, {
          from_revision: 2,
          to_revision: 3,
          changes: [
            {
              path: 'lines 3-3',
              kind: 'changed',
              before: 'Yield was 82%.',
              after: 'Yield was 80%.',
            },
          ],
        });
      }
      return json(404, {});
    });
    restore = stub.restore;
    render(<DocumentView sessionId={SID} view={doc} spec={spec} isHead />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const text = screen.getByRole('textbox', { name: 'Document text (Markdown)' });
    fireEvent.change(text, { target: { value: '# Draft\n\nYield was 85%.' } });
    fireEvent.change(screen.getByRole('textbox', { name: /What you changed/ }), {
      target: { value: 'Corrected the yield' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save as revision 3' }));

    const prompt = await screen.findByRole('alert');
    expect((await within(prompt).findAllByText('lines 3-3')).length).toBeGreaterThan(0);
    expect(JSON.parse(String(stub.calls[0]?.init?.body))).toEqual({
      parent_revision: 2,
      spec: { kind: 'document', markdown: '# Draft\n\nYield was 85%.' },
      change_note: 'Corrected the yield',
    });

    fireEvent.click(
      within(prompt).getByRole('button', { name: 'Save my edit on top of revision 3' }),
    );
    await waitFor(() => expect(posts).toBe(2));
    const retried = stub.calls.filter((c) => c.init?.method === 'POST')[1];
    expect(JSON.parse(String(retried?.init?.body))).toMatchObject({
      parent_revision: 3,
      spec: { kind: 'document', markdown: '# Draft\n\nYield was 85%.' },
    });
  });

  it('discards a stale edit without writing anything', async () => {
    const stub = stubFetch((url, init) =>
      init?.method === 'POST'
        ? json(409, { detail: { code: 'stale_revision', head_revision: 3 } })
        : json(200, { from_revision: 2, to_revision: 3, changes: [] }),
    );
    restore = stub.restore;
    render(<DocumentView sessionId={SID} view={doc} spec={spec} isHead />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Document text (Markdown)' }), {
      target: { value: 'changed' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save as revision 3' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard my edit' }));
    expect(stub.calls.filter((c) => c.init?.method === 'POST')).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('a chart artefact', () => {
  const spec: ChartSpec = {
    kind: 'chart',
    chart: 'line',
    x_label: 'Time (h)',
    y_label: 'Conversion (%)',
    series: [
      { name: 'Run A', x: [0, 2, 4], y: [0, 40, 75] },
      { name: 'Run B', x: [0, 2, 4], y: [0, 30, 60] },
    ],
  };

  it('captions an agent-authored chart as transcribed, and lists every value it draws', () => {
    const view = { ...table, kind: 'chart', author_kind: 'agent', spec } as ExhibitView;
    render(<ChartView view={view} spec={spec} />);
    expect(screen.getByText(TRANSCRIBED_CAPTION)).toBeTruthy();
    expect(TRANSCRIBED_CAPTION).toBe(
      'Values transcribed by the agent — not linked to tool results.',
    );
    const img = screen.getByRole('img');
    expect(img.getAttribute('data-chart')).toBe('line');
    // The accessible reading: one row per point, with the axis labels as headers.
    const region = screen.getByRole('region', { name: /the values plotted/ });
    expect(
      within(region)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Series', 'Time (h)', 'Conversion (%)']);
    expect(within(region).getAllByRole('row')).toHaveLength(1 + 6);
    // Two series are told apart by more than colour, and the legend says how.
    expect(screen.getByRole('list', { name: 'Series' }).textContent).toBe('Run ARun B');
  });

  it('says nothing about transcription over a chemist’s own revision', () => {
    const view = { ...table, kind: 'chart', author_kind: 'human', spec } as ExhibitView;
    render(<ChartView view={view} spec={spec} />);
    expect(screen.queryByText(TRANSCRIBED_CAPTION)).toBeNull();
  });

  it('draws a bar chart over categories, starting at zero', () => {
    const bars: ChartSpec = {
      kind: 'chart',
      chart: 'bar',
      x_label: 'Solvent',
      y_label: 'Yield (%)',
      series: [{ name: 'Yield', x: ['2-MeTHF', 'CPME'], y: [82, 64] }],
    };
    render(<ChartView view={{ ...table, spec: bars } as ExhibitView} spec={bars} />);
    expect(screen.getByRole('img').querySelectorAll('rect')).toHaveLength(2);
    expect(screen.getByRole('img').textContent).toContain('starting at zero');
  });
});

describe('a structures artefact', () => {
  it('draws a labelled tile per structure, each enlargeable', () => {
    render(
      <StructuresView
        spec={{
          kind: 'structures',
          items: [
            { smiles: 'CCO', label: 'ethanol', props: { 'bp (°C)': 78.4 } },
            { smiles: 'c1ccccc1', label: '', props: {} },
          ],
        }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Enlarge ethanol' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enlarge c1ccccc1' })).toBeTruthy();
    expect(screen.getByText('bp (°C)')).toBeTruthy();
  });

  it('builds an SDF from RDKit molblocks, or refuses whole when one cannot be read', async () => {
    const made = await sdfOf([
      { smiles: 'CCO', label: 'ethanol', props: { 'bp (°C)': 78.4 } },
      { smiles: 'O', label: 'water', props: {} },
    ]);
    expect('sdf' in made && made.sdf).toBe(
      'ethanol\n     RDKit          2D\n\n  1  0  0  0\nM  END\n>  <bp (°C)>\n78.4\n\n$$$$\n' +
        'water\n     RDKit          2D\n\n  1  0  0  0\nM  END\n$$$$\n',
    );
    await expect(
      sdfOf([
        { smiles: 'CCO', label: '', props: {} },
        { smiles: 'not-a-molecule', label: '', props: {} },
      ]),
    ).resolves.toEqual({ unreadable: ['not-a-molecule'] });
  });
});

describe('the qualifiers around a view', () => {
  it('lists unverified figures in the contract’s words, and nothing when there are none', () => {
    const { container, rerender } = render(<UnverifiedStrip figures={['4.76', '82']} />);
    expect(container.textContent).toBe(
      'Not found in any tool result this session (unchecked — not necessarily wrong): 4.76, 82',
    );
    rerender(<UnverifiedStrip figures={[]} />);
    expect(container.textContent).toBe('');
  });

  it('names a revision as `r3 · agent · 14:02`, and the reader’s own as “you”', () => {
    const at = new Date(2026, 9, 2, 14, 2).toISOString();
    const base = {
      revision: 3,
      parent_revision: 2,
      author_kind: 'agent' as const,
      author: 'chemclaw',
      change_note: '',
      created_at: at,
      byte_size: 1,
    };
    expect(revisionLabel(base, 'me')).toBe('r3 · agent · 14:02');
    expect(revisionLabel({ ...base, author_kind: 'human', author: 'me' }, 'me')).toBe(
      'r3 · you · 14:02',
    );
    expect(revisionLabel({ ...base, author_kind: 'human', author: 'ann' }, 'me')).toBe(
      'r3 · ann · 14:02',
    );
  });
});
