/**
 * The full result, rendered as data instead of as 200 characters of the model's paraphrase.
 *
 * Two properties carry these tests, and both come from the service rather than from taste.
 *
 * `text` is not promised to be JSON — upstream types it as text on purpose, because a tool result
 * is whatever the framework handed back. So the panel has to survive every shape, and the floor
 * (the raw text) has to be reached rather than an error.
 *
 * A `verdict` renders before the data it qualifies. The dangerous reading of a hazard screen is
 * the *empty* one: no rule matched is explicitly not a clearance, and a table with nothing in it
 * says the opposite unless the sentence above it is there.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ResultSheet } from '../src/components/ResultSheet.tsx';
import { stubFetch } from './helpers.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
}));

const SID = 'a'.repeat(32);
const REF = 'b'.repeat(64);

let restore: (() => void) | null = null;

/** Serve one stored result and open the panel on it. */
function open(tool: string, text: string): void {
  const stub = stubFetch(
    () =>
      new Response(
        JSON.stringify({ ref: REF, tool, correlation_id: 'turn-9', byte_size: text.length, text }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  restore = stub.restore;
  render(
    <ResultSheet sessionId={SID} resultRef={REF} tool={tool} open onOpenChange={() => undefined} />,
  );
}

beforeEach(cleanup);
afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

describe('ResultSheet', () => {
  it('renders a hazard screen as a severity table with its citations', async () => {
    open(
      'screen_hazards',
      JSON.stringify({
        verdict: '1 hazard rule(s) matched (most serious: high).',
        screened: [],
        flags: [
          {
            rule_id: 'organic-azide',
            severity: 'high',
            explanation: 'Low carbon-to-nitrogen ratio; shock sensitive.',
            citation: 'Bretherick 7th ed.',
            matched: 'CCN=[N+]=[N-]',
          },
        ],
      }),
    );

    expect(await screen.findByText('organic-azide')).toBeTruthy();
    expect(screen.getByText('Low carbon-to-nitrogen ratio; shock sensitive.')).toBeTruthy();
    expect(screen.getByText('Bretherick 7th ed.')).toBeTruthy();
    // The verdict, above the table it qualifies.
    expect(screen.getByText(/1 hazard rule\(s\) matched/)).toBeTruthy();
  });

  it('says a clean screen is not a clearance, which is the reading that gets people hurt', async () => {
    open(
      'screen_hazards',
      JSON.stringify({ verdict: 'No rule matched.', screened: [], flags: [] }),
    );

    expect(await screen.findByText(/not.*a clearance/i)).toBeTruthy();
  });

  it('shows an ICH limit with the guideline it came from', async () => {
    // The provenance is the point: this table exists upstream because a PDE was once recited
    // from training as though it were the record.
    open(
      'ich_impurity_limit',
      JSON.stringify({
        query: 'palladium',
        verdict: 'Found in ICH Q3D.',
        limit: {
          substance: 'Palladium',
          guideline: 'ICH Q3D(R2)',
          limit_class: '2B',
          class_meaning: 'Low abundance; PDE applies when intentionally added.',
          limits: [{ basis: 'oral PDE', value: 100, unit: 'µg/day' }],
          citation: 'Table A.2.1',
        },
      }),
    );

    expect(await screen.findByText('Palladium')).toBeTruthy();
    expect(screen.getByText('oral PDE')).toBeTruthy();
    expect(screen.getByText('µg/day')).toBeTruthy();
    expect(screen.getByText(/ICH Q3D\(R2\).*Table A\.2\.1/)).toBeTruthy();
  });

  it('shows a miss as a miss rather than as an absence of limits', async () => {
    open('ich_impurity_limit', JSON.stringify({ query: 'unobtainium', limit: null }));

    expect(await screen.findByText(/no limit on file/i)).toBeTruthy();
  });

  it('renders a charge table and names what it could not resolve', async () => {
    open(
      'stoichiometry_table',
      JSON.stringify({
        basis_name: 'aryl bromide',
        basis_mass_g: 10,
        rows: [
          {
            name: 'aryl bromide',
            smiles: 'Brc1ccccc1',
            role: 'basis',
            equivalents: 1,
            molecular_weight: 157.01,
            moles_mmol: 63.7,
            mass_g: 10,
          },
        ],
        unresolved: ['the ligand we call L7'],
      }),
    );

    // Twice: once naming the basis, once as its own row. Both are wanted.
    expect(await screen.findAllByText('aryl bromide')).toHaveLength(2);
    expect(screen.getByText('157.01')).toBeTruthy();
    // A species that never made it into the table is stated, not silently missing — it is the
    // term that would flatter a downstream E-factor.
    expect(screen.getByText(/the ligand we call L7/)).toBeTruthy();
  });

  it('falls back to a generic table for a tool it has no renderer for', async () => {
    // There are roughly fifty tools on the service. A renderer per tool means every new one is
    // invisible here until someone writes one.
    open(
      'find_calculations',
      JSON.stringify([
        { calc_ref: 'xtb-1', property: 'pka', value: 9.2 },
        { calc_ref: 'xtb-2', property: 'logd', value: 1.4 },
      ]),
    );

    expect(await screen.findByText('xtb-1')).toBeTruthy();
    expect(screen.getByText('calc_ref')).toBeTruthy();
    // A table that cannot leave the browser gets retyped into a spreadsheet by hand, which is
    // where a transcription error enters a campaign.
    expect(screen.getByRole('button', { name: /Download CSV/ })).toBeTruthy();
  });

  it('quotes a CSV field that would otherwise break the file', async () => {
    // RFC 4180: a comma, a quote or a newline forces quoting, and an embedded quote is doubled.
    // Getting this wrong silently shifts every column after it, which a reader discovers in a
    // spreadsheet rather than here.
    open(
      'find_calculations',
      JSON.stringify([{ note: 'ran hot, then cooled', quote: 'he said "no"' }]),
    );
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
      await waitFor(() => expect(captured).toContain('"ran hot, then cooled"'));
      expect(captured).toContain('"he said ""no"""');
    } finally {
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
    }
  });

  it('shows the raw text when the result is not JSON at all', async () => {
    open('gather_evidence', 'Three notes matched, none newer than 2024.');

    expect(await screen.findByText('Three notes matched, none newer than 2024.')).toBeTruthy();
  });

  it('says so when the stored result is gone, rather than showing an empty panel', async () => {
    const stub = stubFetch(
      () =>
        new Response(JSON.stringify({ detail: 'unknown session' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );
    restore = stub.restore;
    render(
      <ResultSheet
        sessionId={SID}
        resultRef={REF}
        tool="screen_hazards"
        open
        onOpenChange={() => undefined}
      />,
    );

    expect(await screen.findByText(/could not be read/i)).toBeTruthy();
  });

  it('carries the correlation id, which is the join a reviewer asks for', async () => {
    open('gather_evidence', 'text');
    expect(await screen.findByText('turn-9')).toBeTruthy();
  });
});
