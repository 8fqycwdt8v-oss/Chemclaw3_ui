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
import type { StoredToolResult } from '../src/api/client.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
}));

const SID = 'a'.repeat(32);
const REF = 'b'.repeat(64);

let restore: (() => void) | null = null;

/** Serve one stored result and open the panel on it. */
function open(tool: string, text: string): void {
  // Named and typed rather than inlined into `JSON.stringify`. An anonymous literal is outside the
  // type system entirely, so the route's declared shape and the body this test serves could drift
  // apart with `tsc -b` green — which is how a component that renders `undefined` against the real
  // service passes here.
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

/**
 * The three searches whose entire output is structures.
 *
 * They used to fall through to `AutoTable`, so the one question a bench chemist asks that is purely
 * about chemistry — "have we made anything like this" — answered with a column of SMILES strings
 * and a decimal.
 *
 * The empty case is the one that matters most, and it is why `FingerprintSearch` is not a bare
 * list: a live run answered `{"result": []}` off an index that had never been backfilled, and it
 * was read as "we have never made anything like this".
 */
describe('a fingerprint search', () => {
  it('draws each hit, with its score and the note it cites', async () => {
    open(
      'similar_molecules',
      JSON.stringify({
        subject: 'molecule',
        verdict: '2 indexed molecule(s) matched this query.',
        index_empty: false,
        hits: [
          { compound_note_id: 'compound-ethanol', smiles: 'CCO', similarity: 0.82 },
          {
            compound_note_id: 'compound-4-bromoanisole',
            smiles: 'COc1ccc(Br)cc1',
            similarity: 0.4,
          },
        ],
      }),
    );

    await waitFor(() => expect(document.querySelector('[data-smiles="CCO"]')).toBeTruthy());
    expect(document.querySelector('[data-smiles="COc1ccc(Br)cc1"]')).toBeTruthy();
    expect(screen.getByText('0.82')).toBeTruthy();
    expect(screen.getByText('compound-ethanol')).toBeTruthy();
  });

  it('hands a hit back to the composer rather than leaving it a picture', async () => {
    const seen: string[] = [];
    const listener = (e: Event): void => {
      seen.push((e as CustomEvent<{ smiles: string }>).detail.smiles);
    };
    window.addEventListener('chemclaw:insert-structure', listener);
    try {
      open(
        'similar_molecules',
        JSON.stringify({
          subject: 'molecule',
          verdict: '1 indexed molecule(s) matched this query.',
          index_empty: false,
          hits: [{ compound_note_id: 'compound-ethanol', smiles: 'CCO', similarity: 0.82 }],
        }),
      );

      const use = await screen.findByLabelText('Use CCO in my message');
      fireEvent.click(use);
      expect(seen).toEqual(['CCO']);
    } finally {
      window.removeEventListener('chemclaw:insert-structure', listener);
    }
  });

  it('says the index was empty, and does not write a softer sentence of its own', async () => {
    open(
      'similar_reactions',
      JSON.stringify({
        subject: 'reaction',
        verdict:
          'SEARCH NOT RUN: the reaction fingerprint index is empty — it holds no searchable record.',
        index_empty: true,
        hits: [],
      }),
    );

    // The service's own sentence, verbatim and above the data it qualifies.
    await waitFor(() => expect(screen.getByText(/SEARCH NOT RUN/)).toBeTruthy());
    expect(screen.getByText(/The question was not answered/)).toBeTruthy();
    // And nothing anywhere that reads as a negative finding.
    expect(document.body.textContent).not.toMatch(/no (analogue|precedent|similar)/i);
  });

  it('marks a truncated hit list as a floor rather than a total', async () => {
    open(
      'similar_molecules',
      JSON.stringify({
        subject: 'molecule',
        verdict: 'PARTIAL RESULT: 1 indexed molecule(s) matched this query.',
        index_empty: false,
        hits_truncated: true,
        hits: [{ compound_note_id: 'compound-ethanol', smiles: 'CCO', similarity: 0.9 }],
      }),
    );

    await waitFor(() => expect(screen.getByText(/a lower bound, not a total/)).toBeTruthy());
  });

  it('renders a substructure match without inventing a score for it', async () => {
    // A substructure match is a yes/no question and carries no similarity. Rendering 0.00 there
    // would be a number that means nothing.
    open(
      'substructure_matches',
      JSON.stringify({
        subject: 'molecule',
        verdict: '1 indexed molecule(s) matched this query.',
        index_empty: false,
        hits: [{ compound_note_id: 'compound-ethanol', smiles: 'CCO', similarity: null }],
      }),
    );

    await waitFor(() => expect(screen.getByText('match')).toBeTruthy());
    expect(screen.queryByText('0.00')).toBeNull();
  });
});

describe('the charge table', () => {
  it('draws each species, because that is what a chemist is weighing out', async () => {
    open(
      'stoichiometry_table',
      JSON.stringify({
        basis_name: '4-bromoanisole',
        basis_mass_g: 1.87,
        unresolved: [],
        rows: [
          {
            name: '4-bromoanisole',
            smiles: 'COc1ccc(Br)cc1',
            role: 'basis',
            equivalents: 1,
            molecular_weight: 187.03,
            moles_mmol: 10,
            mass_g: 1.87,
          },
          {
            name: 'ethanol',
            smiles: 'CCO',
            role: 'solvent',
            equivalents: 17.1,
            molecular_weight: 46.07,
            moles_mmol: 171,
            mass_g: 7.89,
            volume_ml: 10,
          },
        ],
      }),
    );

    // ChargeRow has carried `smiles` all along and this renderer read every other field of it.
    await waitFor(() =>
      expect(document.querySelector('[data-smiles="COc1ccc(Br)cc1"]')).toBeTruthy(),
    );
    expect(document.querySelector('[data-smiles="CCO"]')).toBeTruthy();
    // And the numbers a chemist charges against are still there.
    expect(screen.getByText('187.03')).toBeTruthy();
  });
});

/**
 * The three Bayesian-optimization results.
 *
 * Every fixture below was produced by constructing the backend's own pydantic models
 * (`chemclaw.science.bo.problem`, `chemclaw.science.bo.progress`,
 * `chemclaw.connectors.bo.server.tools`) and dumping them, rather than written by hand — including
 * the `summary` computed fields, which is why they read the way they do. A hand-written fixture is
 * the failure the fingerprint tests already paid for once: an assertion can only disagree with the
 * fixture it was handed, and a field name invented here would render nothing against the real
 * service while passing in this file.
 *
 * What each test pins is the half of the payload that is lost when it renders as a table: the assay
 * noise a gain has to be read against, the verdict the service *declined* to give, the front that
 * has no single best point, and a number the model reached by extrapolating.
 */
describe('a campaign progress reading', () => {
  /** A plateaued eight-run campaign against a stated ±2% assay, exactly as `campaign_progress`
   *  returns it. */
  const PLATEAUED = {
    objective: 'yield',
    direction: 'maximize',
    assay_noise: 2.0,
    window: 4,
    n_observations: 8,
    n_distinct: 8,
    design_space: null,
    best_value: 87.6,
    best_so_far: [51.0, 63.5, 71.0, 86.4, 87.1, 87.1, 87.6, 87.6],
    evaluations_since_improvement: 4,
    window_span: 1.5999999999999943,
    window_indistinguishable: true,
    enough_observations: true,
    plateaued: true,
    summary:
      'Best yield so far: 87.6 over 8 evaluation(s). The last gain larger than the stated assay ' +
      'noise (+/-2) was 4 evaluation(s) ago. The most recent 4 results span 1.6, so they are NOT ' +
      'distinguishable from each other. Plateaued: no further gain beyond the noise for at least ' +
      '4 evaluation(s). This is a reading of the runs supplied and nothing more.',
  };

  it('divides feasible runs by feasible cells when an exclusion makes them differ', async () => {
    // The two counts differ exactly when the history holds a run an exclusion later forbade — the
    // ordinary case of a pairing excluded after being run once. Rendering `n_distinct` over
    // `design_space` reads "4 / 3": more conditions run than the grid contains, which a chemist
    // reads as a broken number rather than as a real exclusion.
    open(
      'campaign_progress',
      JSON.stringify({
        ...PLATEAUED,
        n_observations: 6,
        n_distinct: 4,
        n_distinct_in_space: 3,
        design_space: 3,
      }),
    );

    expect(await screen.findByText('3 / 3')).toBeTruthy();
    expect(screen.queryByText('4 / 3')).toBeNull();
    expect(screen.getByText(/1 further run\(s\) are outside it/)).toBeTruthy();
  });

  it('draws the best-so-far series with the assay noise made visible', async () => {
    open('campaign_progress', JSON.stringify(PLATEAUED));

    // The chart is a chart, and it names what it draws. The whole reason the band is on it: a
    // difference smaller than the assay is not a difference, and a bare line invites the opposite.
    const chart = await screen.findByRole('img', { name: /Best yield so far/ });
    expect(chart.textContent).toContain('higher is better');
    expect(screen.getByText(/The shaded band is ±2/)).toBeTruthy();
    // The verdict as a state, not as a sentence to be skimmed past.
    expect(screen.getByText('Plateaued')).toBeTruthy();
    // And the three numbers a lab leader decides on.
    expect(screen.getByText('Evaluations')).toBeTruthy();
    expect(screen.getByText(/evaluation\(s\) since a gain beat the noise/)).toBeTruthy();
    expect(screen.getByText(/the grid is infinite/)).toBeTruthy();
  });

  it('withholds the plateau verdict on too few runs instead of showing a confident chip', async () => {
    // The case this renderer exists for. Upstream computes `plateaued = enough and since >= window`,
    // so on two runs it is `false` — and rendering `false` as "still improving" would answer a
    // question the service explicitly declined to answer.
    open(
      'campaign_progress',
      JSON.stringify({
        ...PLATEAUED,
        n_observations: 2,
        n_distinct: 2,
        best_value: 63.5,
        best_so_far: [51.0, 63.5],
        evaluations_since_improvement: 0,
        window_span: 12.5,
        window_indistinguishable: false,
        enough_observations: false,
        plateaued: false,
        summary:
          '2 evaluation(s) is too few to read a trend from — this needs at least 6. No plateau ' +
          'verdict is given, which is different from saying the campaign is still improving.',
      }),
    );

    expect(await screen.findByText('Plateau verdict withheld')).toBeTruthy();
    expect(screen.queryByText('Plateaued')).toBeNull();
    expect(screen.queryByText('Still improving')).toBeNull();
    // And the reason, stated as the absence of a finding rather than as a finding.
    expect(screen.getByText(/is the absence of a finding either way/)).toBeTruthy();
  });

  it('calls a moving campaign moving, so the withheld state is not the only non-plateau', async () => {
    open(
      'campaign_progress',
      JSON.stringify({ ...PLATEAUED, evaluations_since_improvement: 0, plateaued: false }),
    );

    expect(await screen.findByText('Still improving')).toBeTruthy();
    expect(screen.queryByText('Plateau verdict withheld')).toBeNull();
  });
});

describe('an experiment suggestion', () => {
  /** Two objectives, five runs supplied, three of them on the front, one real candidate and one
   *  seed point — the shape `suggest_next_experiment` returns for a trade-off. */
  const MULTI = {
    campaign_id: 'bo-9f2c1ad4',
    candidates: [
      {
        params: { temperature_c: 92.0, ligand: 'L2' },
        predicted_value: 88.2,
        predicted_sd: 3.4,
        predicted_values: { yield: 88.2, impurity: 1.9 },
        predicted_sds: { yield: 3.4, impurity: 0.6 },
      },
      {
        params: { temperature_c: 35.0, ligand: 'L3' },
        predicted_value: null,
        predicted_sd: null,
        predicted_values: {},
        predicted_sds: {},
      },
    ],
    requested: 2,
    calc_refs: ['xtb:abc123', 'xtb:def456'],
    scale: {
      name: 'yield',
      direction: 'maximize',
      n: 5,
      observed_min: 51.0,
      observed_max: 86.4,
      observed_sd: 13.272980072312324,
    },
    scales: [
      {
        name: 'yield',
        direction: 'maximize',
        n: 5,
        observed_min: 51.0,
        observed_max: 86.4,
        observed_sd: 13.272980072312324,
      },
      {
        name: 'impurity',
        direction: 'minimize',
        n: 5,
        observed_min: 0.4,
        observed_max: 3.1,
        observed_sd: 1.1819475453673907,
      },
    ],
    front: [
      {
        params: { temperature_c: 60.0, ligand: 'L2' },
        value: 71.0,
        values: { yield: 71.0, impurity: 1.4 },
        provenance: 'measured',
        surrogate_sd: null,
      },
      {
        params: { temperature_c: 80.0, ligand: 'L2' },
        value: 86.4,
        values: { yield: 86.4, impurity: 3.1 },
        provenance: 'measured',
        surrogate_sd: null,
      },
      {
        params: { temperature_c: 80.0, ligand: 'L3' },
        value: 62.0,
        values: { yield: 62.0, impurity: 0.4 },
        provenance: 'measured',
        surrogate_sd: null,
      },
    ],
    front_tolerance: 0.5,
    opened_new_campaign: false,
    summary:
      'This is a trade-off over 2 objectives (maximize yield, minimize impurity), so there is no ' +
      'single best point.',
  };

  it('renders each candidate with its prediction and the sd tied to it', async () => {
    open('suggest_next_experiment', JSON.stringify(MULTI));

    expect(await screen.findByText('Candidate 1')).toBeTruthy();
    // The sd is a qualification of the value, not a second number in a second column — so it is
    // asserted as one string, which is what the reader has to be unable to drop.
    expect(screen.getByText('± 3.4')).toBeTruthy();
    expect(screen.getByText(/predicted yield \(maximize\)/)).toBeTruthy();
    expect(screen.getByText(/predicted impurity \(minimize\)/)).toBeTruthy();
    // The conditions, which are the thing a chemist actually sets up.
    expect(screen.getByText('92')).toBeTruthy();
    // A seed point had no surrogate behind it, which upstream says "is not an endorsement".
    expect(screen.getByText(/space-filling seed/)).toBeTruthy();
    // The handle a later turn quotes to continue this campaign.
    expect(screen.getByText('bo-9f2c1ad4')).toBeTruthy();
  });

  it('draws a two-objective front as a scatter and marks who is on it', async () => {
    open('suggest_next_experiment', JSON.stringify(MULTI));

    const chart = await screen.findByRole('img', {
      name: /Trade-off between yield and impurity/,
    });
    // Both objective names AND both directions: a front is unreadable without knowing which way
    // is better on each axis.
    expect(chart.textContent).toContain('higher is better');
    expect(chart.textContent).toContain('lower is better');
    // Front membership is a label, never colour alone — three runs, three labelled rows.
    expect(screen.getAllByText('on the front')).toHaveLength(3);
    // And the runs that are NOT on it are accounted for rather than silently absent: this result
    // carries only the front, so the count is stated instead of drawn.
    expect(screen.getByText(/the other 2 are beaten on every objective at once/)).toBeTruthy();
    expect(screen.getByText(/Runs differing by 0.5 or less/)).toBeTruthy();
  });

  it('refuses a 2-D scatter for three objectives and says why', async () => {
    // A three-objective front on two axes drops one of them, and a reader cannot see that it
    // happened. The table is the honest answer.
    open(
      'suggest_next_experiment',
      JSON.stringify({
        campaign_id: 'bo-3obj',
        candidates: [
          {
            params: { temperature_c: 70.0 },
            predicted_value: 80.0,
            predicted_sd: 2.0,
            predicted_values: {},
            predicted_sds: {},
          },
        ],
        requested: 1,
        calc_refs: [],
        scale: {
          name: 'yield',
          direction: 'maximize',
          n: 3,
          observed_min: 51.0,
          observed_max: 86.4,
        },
        scales: [
          { name: 'yield', direction: 'maximize', n: 3, observed_min: 51.0, observed_max: 86.4 },
          { name: 'impurity', direction: 'minimize', n: 3, observed_min: 0.9, observed_max: 3.1 },
          { name: 'cost', direction: 'minimize', n: 3, observed_min: 12.0, observed_max: 30.0 },
        ],
        front: [
          {
            params: { temperature_c: 40.0 },
            value: 51.0,
            values: { yield: 51.0, impurity: 0.9, cost: 12.0 },
            provenance: 'measured',
            surrogate_sd: null,
          },
          {
            params: { temperature_c: 80.0 },
            value: 86.4,
            values: { yield: 86.4, impurity: 3.1, cost: 30.0 },
            provenance: 'measured',
            surrogate_sd: null,
          },
        ],
        front_tolerance: null,
        opened_new_campaign: false,
        summary: 'This is a trade-off over 3 objectives.',
      }),
    );

    expect(await screen.findByText(/cannot be drawn as a two-axis scatter/)).toBeTruthy();
    expect(screen.queryByRole('img', { name: /Trade-off between/ })).toBeNull();
    // The front is still answered, and all three axes are columns of it.
    expect(screen.getAllByText('on the front')).toHaveLength(2);
    expect(screen.getByRole('columnheader', { name: 'cost' })).toBeTruthy();
    // Drawn at exact precision, which upstream says is usually a shorter front than the truth.
    expect(screen.getByText(/every numeric difference counted as real/)).toBeTruthy();
  });

  it('says a new campaign was opened, which is the one thing the summary never mentions', async () => {
    // The tool's own docstring is imperative about this: "If `opened_new_campaign` comes back true,
    // say so before presenting the candidates." It means the decision space drifted and the history
    // is now split in two, and the computed `summary` says nothing about it.
    open('suggest_next_experiment', JSON.stringify({ ...MULTI, opened_new_campaign: true }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/new campaign was opened/);
    expect(alert.textContent).toMatch(/split across two campaigns/);
  });

  it('does not claim a front for a campaign with nothing measured yet', async () => {
    open(
      'suggest_next_experiment',
      JSON.stringify({
        ...MULTI,
        candidates: [MULTI.candidates[1]],
        front: [],
        scales: MULTI.scales.map((scale) => ({
          ...scale,
          n: 0,
          observed_min: null,
          observed_max: null,
          observed_sd: null,
        })),
        summary: 'no runs were supplied, so there is no front yet',
      }),
    );

    expect(await screen.findByText(/nothing has been measured/)).toBeTruthy();
    expect(screen.queryByRole('img', { name: /Trade-off between/ })).toBeNull();
    // And a ± with nothing to be read against is stated as such rather than left implied.
    expect(screen.getAllByText(/has nothing to be read against/).length).toBeGreaterThan(0);
  });
});

describe('a surrogate prediction', () => {
  const ANSWER = {
    predictions: [
      {
        params: { temperature_c: 90.0, ligand: 'L2' },
        values: { yield: 84.31 },
        sds: { yield: 2.6 },
        in_domain: true,
        summary:
          'The model predicts yield 84.31 ± 2.6 here. This is an answer about a point you named, ' +
          'not a recommendation to run it.',
      },
      {
        params: { temperature_c: 400.0, ligand: 'L2' },
        values: { yield: 131.7 },
        sds: { yield: 16.08 },
        in_domain: false,
        summary:
          'The model predicts yield 131.7 ± 16.1 here. This point is **outside** the declared ' +
          'range, so the model is extrapolating.',
      },
    ],
    fit: [{ objective: 'yield', r2: 0.93, mae: 1.42, folds: 5, n_observations: 8, summary: '' }],
    summary: 'Cross-validated on 8 run(s) over 5 folds, R² 0.93 and mean absolute error 1.4.',
  };

  it('marks an out-of-domain prediction as an extrapolation', async () => {
    open('predict_outcome', JSON.stringify(ANSWER));

    // The backend deliberately answers rather than refuses here, and returns the number *plus* the
    // fact that it is an extrapolation. Printing the mean and losing the flag turns a qualified
    // answer into an unqualified one, which is worse than not rendering it at all.
    expect(await screen.findByText('extrapolation')).toBeTruthy();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/outside the declared range/);
    expect(alert.textContent).toMatch(/nothing constrains the mean/);
    // The in-range point is labelled too, so the mark means something by contrast.
    expect(screen.getByText('inside the declared space')).toBeTruthy();
  });

  it('keeps each prediction with its own uncertainty and its own caveat', async () => {
    open('predict_outcome', JSON.stringify(ANSWER));

    expect(await screen.findByText('84.31')).toBeTruthy();
    expect(screen.getByText('± 2.6')).toBeTruthy();
    expect(screen.getByText('131.7')).toBeTruthy();
    expect(screen.getByText('± 16.08')).toBeTruthy();
    // Per prediction, not pooled: unlike the fit summaries, this sentence is about one point.
    expect(screen.getByText(/not a recommendation to run it/)).toBeTruthy();
  });

  it('reports the fit quality the predictions have to be read against', async () => {
    open('predict_outcome', JSON.stringify(ANSWER));

    expect(await screen.findByText('R² 0.93')).toBeTruthy();
    expect(screen.getByText(/5 folds over 8 run\(s\)/)).toBeTruthy();
  });
});
