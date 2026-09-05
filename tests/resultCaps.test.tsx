/**
 * A long result is capped, and the reader is told — never truncated, and never subtracted from.
 *
 * The full view had no cap at all: `take` is the identity when not compact, so every record the
 * service sent became a `<tr>` and every hit became an RDKit drawing. Measured, a 2,000-row result
 * is ~1.1 s of render for 20,000 cells (vitest + happy-dom, which inflates DOM work — the ratio is
 * what transfers, and the ratio is linear in rows), and a 200-hit similarity result is 1.03 s of
 * blocked main thread and 2.0 MB of SVG (bare node, real RDKit: 5.2 ms and 10.3 kB per drug-like
 * structure). Both arrive with no paint in between, so the tab is frozen rather than slow.
 *
 * **The thing a cap must not become is a quiet subtraction.** This app is arranged against a wrong
 * or partial number reaching a chemist unwarned, and "the first 100 of 2,000 rows, silently" is
 * exactly that: a table that reads as the result. So every assertion here is about the *telling* as
 * much as the capping —
 *
 *  - the count says how many of how many were drawn;
 *  - a control draws the rest, in pages and in one go;
 *  - the CSV keeps covering the **whole** set, because it is the escape hatch and its own docstring
 *    says a run sheet retyped by hand is where a transcription error enters a campaign;
 *  - the compact card is unchanged, and still points at the full result rather than offering to
 *    grow inside the answer.
 *
 * Four of these fail with the cap removed — verified by lifting the two limits and watching them go
 * red at 2,000 rows and 200 drawings. The other four pass either way on purpose: they are the
 * invariants the cap is allowed to touch and did not (the whole-set CSV, the whole-set header
 * union, a short result left alone, and the compact card), and a change that broke one of those
 * while keeping the counts right would be the harmful version of this fix.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ResultSheet } from '../src/components/ResultSheet.tsx';
import { rendererFor } from '../src/results/renderers.tsx';
import { stubFetch } from './helpers.ts';
import type { StoredToolResult } from '../src/api/client.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
}));

const SID = 'a'.repeat(32);
const REF = 'b'.repeat(64);

let restore: (() => void) | null = null;

/** Serve one stored result and open the panel on it — the full view, which is what gained a cap. */
function open(tool: string, payload: unknown): void {
  const text = JSON.stringify(payload);
  const stored: StoredToolResult = {
    ref: REF,
    tool,
    correlation_id: 'turn-9',
    byte_size: text.length,
    text,
  };
  const stub = stubFetch(
    () =>
      new Response(JSON.stringify(stored), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  restore = stub.restore;
  render(
    <ResultSheet sessionId={SID} resultRef={REF} tool={tool} open onOpenChange={() => undefined} />,
  );
}

/** A generic record list — what `run_python`, a warehouse query or any untyped tool returns. */
const records = (n: number): { result: Record<string, unknown>[] } => ({
  result: Array.from({ length: n }, (_, i) => ({
    run: i,
    solvent: ['toluene', 'MeCN', 'THF', 'DMF'][i % 4],
    yield_pct: 40 + ((i * 7) % 55),
    k_per_s: 4.2e-6,
  })),
});

/** How many body rows the table actually drew. The header row is `<thead>`, so it is not counted. */
const bodyRows = (): number => document.querySelectorAll('tbody tr').length;

beforeEach(cleanup);
afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

describe('the full view of a long table', () => {
  it('draws the first hundred rows and says how many it did not', async () => {
    open('run_python', records(2000));
    await screen.findByText('run');

    expect(bodyRows()).toBe(100);
    // The sentence a reader has to be able to act on: which subset this is, and that the rest are
    // held back rather than absent.
    expect(screen.getByText(/100 of 2000 rows drawn/)).toBeTruthy();
    expect(screen.getByText(/not\s+dropped/)).toBeTruthy();
  });

  it('draws the next hundred when asked, and all of them when asked for that', async () => {
    open('run_python', records(2000));
    await screen.findByText('run');

    fireEvent.click(screen.getByRole('button', { name: 'Show 100 more' }));
    await waitFor(() => expect(bodyRows()).toBe(200));
    expect(screen.getByText(/200 of 2000 rows drawn/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show all 2000' }));
    await waitFor(() => expect(bodyRows()).toBe(2000));
    // Nothing left to say once everything is on screen.
    expect(screen.queryByText(/rows drawn/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Show/ })).toBeNull();
  });

  it('leaves a result that fits alone, with no sentence and no control', async () => {
    open('run_python', records(12));
    await screen.findByText('run');

    expect(bodyRows()).toBe(12);
    expect(screen.queryByText(/rows drawn/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Show/ })).toBeNull();
  });

  it('exports every row, not the drawn ones — the CSV is the escape hatch', async () => {
    open('run_python', records(2000));
    await screen.findByRole('button', { name: /Download CSV/ });

    let captured = '';
    const createObjectURL = URL.createObjectURL;
    const revokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = ((blob: Blob) => {
      void blob.text().then((text) => {
        captured = text;
      });
      return 'blob:stub';
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;

    try {
      fireEvent.click(screen.getByRole('button', { name: /Download CSV/ }));
      // 2,000 records plus the header line. The last row is the one a capped CSV would lose, so it
      // is named rather than counted: a count alone would pass on the first 2,000 of 4,000.
      await waitFor(() => expect(captured.split('\r\n').length).toBe(2001));
      expect(captured.split('\r\n')[2000]).toContain('1999');
    } finally {
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
    }
  });

  it('takes its columns from every record, not from the hundred it drew', async () => {
    // A column that first appears in row 1,500 is still a column — the header union is over the
    // whole set on purpose, and it costs 1.0 ms at 2,000 records. Capping *that* would be the
    // silent subtraction this whole file is against, and it would be invisible in the table.
    const rows = records(2000).result;
    rows[1500] = { ...rows[1500], late_arriving_column: 7 };
    open('run_python', { result: rows });
    await screen.findByText('run');

    expect(screen.getByText('late_arriving_column')).toBeTruthy();
  });
});

describe('the full view of a structure grid', () => {
  /** `similar_molecules` — the shape whose every row is drawn by RDKit rather than printed. */
  const hits = (n: number): unknown => ({
    verdict: `${n} analogue(s) found.`,
    subject: 'compound',
    index_empty: false,
    hits: Array.from({ length: n }, (_, i) => ({
      smiles: 'CCO',
      similarity: 0.99 - i / 1000,
      compound_note_id: `note-${String(i).padStart(4, '0')}`,
    })),
  });

  it('draws twenty-four hits of two hundred and offers the rest', async () => {
    open('similar_molecules', hits(200));
    await screen.findByText(/200 analogue\(s\) found/);

    // One `<li>` per hit in the grid. 200 of these is a second of blocked main thread and 2 MB of
    // SVG, which is the whole reason for the cap.
    expect(document.querySelectorAll('ul > li').length).toBe(24);
    expect(screen.getByText(/24 of 200 hits drawn/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show 24 more' }));
    await waitFor(() => expect(document.querySelectorAll('ul > li').length).toBe(48));
  });

  it('is the same cap for the structures a hazard screen says it screened', async () => {
    // Same grid, different renderer: `screened` draws one `<Molecule>` per entry too, and it had
    // no cap in the full view either. The flag table beside it is deliberately NOT capped — those
    // rows are the finding.
    open('screen_hazards', {
      verdict: 'no rule matched',
      // Distinct strings, because the grid keys on the SMILES itself.
      screened: Array.from({ length: 40 }, (_, i) => `${'C'.repeat(i + 1)}O`),
      flags: [],
    });
    await screen.findByText(/24 of 40 structures drawn/);
  });
});

describe('the compact card is unchanged by any of it', () => {
  it('still shows its three rows and still points at the full result', () => {
    const picked = rendererFor('run_python', records(2000))!;
    render(
      <picked.renderer.View
        data={picked.data}
        tool="run_python"
        compact
        onUsed={() => undefined}
      />,
    );

    expect(bodyRows()).toBe(3);
    // The card cannot grow into the answer: the panel is where more rows live, and the sentence
    // says so rather than offering a control.
    expect(screen.getByText('3 of 2000 shown — open the full result for the rest.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Show/ })).toBeNull();
  });
});
