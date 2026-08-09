/**
 * Typed result cards.
 *
 * A turn that screened six molecules, computed three pKa values and ranked four solvents used to
 * produce zero chemistry UI: the backend's typed results — `ScreenResult`, `ChargeTable`,
 * `ImpurityLimitLookup`, `SolventComparisonResult` — never crossed the wire, and what reached the
 * chemist was prose the model wrote about them. These specs pin the two halves of the fix.
 *
 * **The payloads below are copied from the backend's own models**
 * (`science/safety/screen.py`, `genotox.py`, `ich.py`, `connectors/chem/server/tools.py`,
 * `connectors/calc/server/tools.py`, `science/calc/*`, `science/fingerprints/store.py`), including
 * the `verdict` computed fields, the envelope a durable job answering inline is wrapped in, and
 * the fields whose *absence* is meaningful. Inventing a tidier shape here would test this file
 * against itself.
 *
 * **The three degradations are load-bearing.** An empty `result_ref` (an older backend, a store
 * that is off, a result over the byte cap, a failed write), a fetch that fails, and a shape
 * nothing cards must all land on the same `<pre>` of the same truncated preview the panel showed
 * before any of this existed. A deployment that never gets the backend change must be unaffected.
 *
 * The safety assertions are the ones worth breaking the build over: a clean hazard screen must
 * still render its verdict, a genotoxicity alert must not acquire a severity nobody assigned it,
 * and a charge table missing a reagent must say so where a chemist reading the rows will see it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { normalizeEvent } from '../shared/events.ts';
import { api } from '../src/api/client.ts';
import { detectResult } from '../src/components/results/shapes.ts';
import { CitedFlags } from '../src/components/results/CitedFlags.tsx';
import { Ranked } from '../src/components/results/Ranked.tsx';
import { RowTable } from '../src/components/results/RowTable.tsx';
import { ValueCard } from '../src/components/results/ValueCard.tsx';
import { TracePanel } from '../src/components/TracePanel.tsx';
import { useChatStore } from '../src/state/chatStore.ts';
import type { TraceEntry } from '../src/state/types.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => 'token' } }),
}));

const SID = 'c'.repeat(32);
const REF = '7f'.repeat(32);

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useChatStore.setState({
    conversations: {},
    order: [],
    activeId: null,
    composerLock: false,
    banner: null,
    jobFeed: [],
    streaming: null,
  });
  const id = useChatStore.getState().createConversation();
  useChatStore.getState().setSessionId(id, SID);
});

/** A returned `tool_call` row, as `closeToolCall` leaves it. */
const row = (tool: string, preview: string, resultRef: string): TraceEntry[] => [
  {
    id: 'row-1',
    at: 0,
    kind: 'tool_call',
    toolCall: { tool, arguments: '{}', result: preview, numbers: [], resultRef },
  },
];

/** What `GET /sessions/{id}/tool-results/{ref}` answers with (`StoredToolResult`). */
const stored = (tool: string, payload: unknown) => ({
  ref: REF,
  tool,
  correlation_id: 'abc123',
  byte_size: JSON.stringify(payload).length,
  text: JSON.stringify(payload),
});

/** Open the panel, then ask the row for its full result. */
async function expandResult(): Promise<void> {
  fireEvent.click(screen.getByText(/Show the agent’s work/));
  fireEvent.click(screen.getByText('Render the full result'));
  await waitFor(() => expect(screen.queryByText('Render the full result')).toBeNull());
}

// ---------------------------------------------------------------------------------------------
// Payloads, as the backend serialises them.
// ---------------------------------------------------------------------------------------------

/** `screen_hazards` -> `ScreenResult`. Deliberately NOT worst-first, to pin the ordering. */
const HAZARDS = {
  flags: [
    {
      rule_id: 'peroxide-forming-ether',
      severity: 'medium',
      explanation: 'Ethers accumulate peroxides on storage; test before distilling to dryness.',
      citation: 'Bretherick’s Handbook, 7th ed., 3.1',
      matched: 'CCO',
    },
    {
      rule_id: 'oxidant-plus-fuel',
      severity: 'high',
      explanation: 'A strong oxidant charged alongside an oxidisable organic can run away.',
      citation: 'Bretherick’s Handbook, 7th ed., 1.4',
      matched: 'CCO + CC(=O)O',
    },
  ],
  screened: ['CCO', 'CC(=O)O'],
  verdict:
    '2 hazard rule(s) matched (most serious: high). Advisory only — a human must assess the procedure.',
};

/** A clean screen. The verdict is the entire result, and the word "safe" is never in it. */
const CLEAN_SCREEN = {
  flags: [],
  screened: ['COc1ccc(Br)cc1'],
  verdict: 'No rule in the hazard table matched. This is not a safety assessment.',
};

/** `screen_genotoxic_alerts` -> `AlertResult`. No severity field anywhere, by design. */
const GENOTOX = {
  alerts: [
    {
      alert_id: 'aromatic-nitro',
      motif: 'aromatic nitro',
      explanation: 'Reduced in vivo to a nitrenium ion that alkylates DNA.',
      citation: 'ICH M7(R2), Addendum',
      matched: 'c1ccccc1',
    },
  ],
  screened: ['c1ccccc1'],
  verdict:
    '1 structural alert(s) matched (aromatic nitro). This is not an ICH M7 classification and not a (Q)SAR.',
};

/**
 * `compare_solvents` answering inside its inline wait: `ConnectorJobResult` wrapping an
 * `XtbJobResult` wrapping the `SolventComparisonResult`. Three envelopes, none of which any
 * detector knows about.
 */
const SOLVENTS = {
  summary: 'Ranked 3 solvents for the esterification; acetonitrile is most favourable.',
  data: {
    kind: 'solvents',
    summary: 'Ranked 3 solvents for the esterification.',
    solvents: {
      reactants: ['CCO', 'CC(=O)O'],
      products: ['CCOC(C)=O', 'O'],
      method: 'GFN2-xTB',
      temperature_k: 298.15,
      level: 'standard',
      effects: [
        { solvent: 'toluene', delta_e_kcal: -3.2, delta_h_kcal: -3.0, delta_g_kcal: -1.8 },
        { solvent: 'acetonitrile', delta_e_kcal: -5.1, delta_h_kcal: -4.8, delta_g_kcal: -3.6 },
        { solvent: null, delta_e_kcal: -1.0, delta_h_kcal: -0.9, delta_g_kcal: 0.4 },
      ],
      best_solvent: 'acetonitrile',
      spread_kcal: 4.0,
      uncertainty_kcal: 1.5,
      warnings: [],
    },
  },
};

/** `similar_molecules` -> `FingerprintSearch[MoleculeHit]`. */
const SIMILAR = {
  subject: 'molecule',
  hits: [
    { compound_note_id: 'compound-4-bromoanisole', smiles: 'COc1ccc(Br)cc1', similarity: 0.87 },
    { compound_note_id: 'compound-methanol', smiles: 'CO', similarity: 0.42 },
  ],
  index_empty: false,
  scan_truncated: false,
  hits_truncated: false,
  verdict: '2 indexed molecule(s) matched this query.',
};

/** `stoichiometry_table` -> `ChargeTable`. `unresolved` names a reagent that is in NO row. */
const CHARGE_TABLE = {
  basis_name: '4-bromoanisole',
  basis_mass_g: 1.87,
  rows: [
    {
      name: '4-bromoanisole',
      smiles: 'COc1ccc(Br)cc1',
      role: 'basis',
      equivalents: 1.0,
      molecular_weight: 187.03,
      moles_mmol: 10.0,
      mass_g: 1.87,
      density_g_per_ml: null,
      volume_ml: null,
    },
    {
      name: 'phenylboronic acid',
      smiles: 'OB(O)c1ccccc1',
      role: 'reagent',
      equivalents: 1.2,
      molecular_weight: 121.93,
      moles_mmol: 12.0,
      mass_g: 1.463,
      density_g_per_ml: null,
      volume_ml: null,
    },
    {
      name: 'ethyl acetate',
      smiles: 'CCOC(C)=O',
      role: 'solvent',
      equivalents: 11.4,
      molecular_weight: 88.11,
      moles_mmol: 113.9,
      mass_g: 10.04,
      density_g_per_ml: 0.902,
      volume_ml: 11.13,
    },
  ],
  unresolved: ['Pd(dppf)Cl2'],
};

/** `ich_impurity_limit` -> `ImpurityLimitLookup`, the hit. */
const ICH_HIT = {
  query: 'toluene',
  limit: {
    substance: 'Toluene',
    guideline: 'ICH Q3C(R8)',
    limit_class: 'Class 2',
    class_meaning: 'Solvents to be limited',
    limits: [
      { basis: 'concentration limit', value: 890.0, unit: 'ppm' },
      { basis: 'PDE', value: 8.9, unit: 'mg/day' },
    ],
    citation: 'ICH Q3C(R8) Table 2',
  },
  verdict:
    'Toluene: ICH Q3C(R8) Table 2. Quote the citation with the number, and note that a limit is not a risk assessment.',
};

/** The miss, which the model exists to keep distinct from "no limit exists". */
const ICH_MISS = {
  query: 'unobtainium',
  limit: null,
  verdict:
    "No entry for 'unobtainium' in the transcribed ICH Q3C/Q3D tables. That means this system does not carry the number — not that no limit exists.",
};

/** `calculator_outliers` -> `OutlierReport`. */
const OUTLIERS = {
  calc_type: 'solubility',
  enabled: true,
  measured: 24,
  matching: 'CC(=O)O',
  residuals: [
    {
      smiles: 'CC(=O)O',
      predicted: -0.4,
      observed: 0.6,
      error: -1.0,
      unit: 'log S',
      within_uncertainty: false,
    },
    {
      smiles: 'CCO',
      predicted: -0.2,
      observed: 0.1,
      error: -0.3,
      unit: 'log S',
      within_uncertainty: null,
    },
  ],
  verdict:
    '2 of 24 measured molecule(s), worst first. Every row is a measurement someone made, so a short list means few measurements.',
};

/** `predict_pka` -> `PkaResult`. */
const PKA = {
  smiles: 'CC(=O)O',
  method: 'gfn2-xtb-alpb-water/acid-v3',
  pka: 4.76,
  deprotonation_energy_kcal: 342.1,
  uncertainty: 0.62,
  site: 'acid',
};

/** `predict_solubility` -> `SolubilityResult`, out of domain. */
const SOLUBILITY = {
  smiles: 'CCO',
  model: 'esol-delaney',
  log_s_mol_per_l: -0.24,
  uncertainty_log: 0.75,
  estimate: {
    value: -0.24,
    unit: 'log S (mol/L)',
    uncertainty: 0.75,
    method: 'reported',
    in_domain: false,
    domain_reasons: ['the input is more than one component (a salt or a co-crystal)'],
  },
};

/** `compute_xtb_energy` -> `XtbResult`. States no uncertainty at all. */
const XTB = {
  smiles: 'CCO',
  method: 'GFN2-xTB',
  charge: 0,
  total_energy_hartree: -25.2412,
};

// ---------------------------------------------------------------------------------------------

describe('carrying the ref off the wire', () => {
  it('mirrors result_ref when the frame has one', () => {
    // Three events reached production missing from `shared/events.ts` before this one, and the
    // pattern between them was always the same: the field existed on the wire and nothing here
    // read it, so the thing it was added to say never arrived.
    expect(
      normalizeEvent({
        type: 'tool_result',
        tool: 'screen_hazards',
        preview: '{"flags": [{"rule_id": "peroxi',
        note_ids: [],
        numbers: [],
        result_ref: REF,
      }),
    ).toMatchObject({ result_ref: REF });
  });

  it('leaves a frame from a backend without the field exactly as it was', () => {
    // The field comes from an unmerged PR, so this is the shape every deployment sends today.
    const event = normalizeEvent({ type: 'tool_result', tool: 'predict_pka', preview: 'pKa 9.2' });
    expect(event && 'result_ref' in event).toBe(false);
  });

  it('rides onto the trace row beside the preview it cannot replace', () => {
    const store = useChatStore.getState();
    const cid = store.createConversation();
    const mid = store.startAssistantMessage(cid);
    store.applyEvent(cid, mid, { type: 'tool_call', tool: 'screen_hazards', arguments: '{}' });
    store.applyEvent(cid, mid, {
      type: 'tool_result',
      tool: 'screen_hazards',
      preview: '{"flags": [{"rule_id": "peroxi',
      note_ids: [],
      numbers: [],
      result_ref: REF,
    });

    const message = useChatStore.getState().conversations[cid]?.messages.at(-1);
    const call = message?.role === 'assistant' ? message.trace[0]?.toolCall : undefined;
    // Both: the preview is what a row shows until somebody asks for more, and the ref is how it
    // asks. Neither replaces the other.
    expect(call?.result).toBe('{"flags": [{"rule_id": "peroxi');
    expect(call?.resultRef).toBe(REF);
  });
});

describe('detecting a result by its shape', () => {
  it('reads a hazard screen off the flags themselves, not off the tool name', () => {
    // The same detector answers for `screen_hazards` and `screen_genotoxic_alerts`, which is the
    // whole point: four renderers, not fifteen. Passing a tool name it has never heard of must
    // not change the answer.
    const detected = detectResult('some_future_screen', HAZARDS);
    expect(detected?.kind).toBe('cited-flags');
  });

  it('orders flags worst first and leaves unranked alerts alone', () => {
    const hazards = detectResult('screen_hazards', HAZARDS);
    expect(hazards?.kind === 'cited-flags' && hazards.flags.map((f) => f.severity)).toEqual([
      'high',
      'medium',
    ]);
    // `GenotoxAlert` has no severity — ranking published alert sets would be the first half of a
    // classification the tables do not make — so nothing here may invent one.
    const genotox = detectResult('screen_genotoxic_alerts', GENOTOX);
    expect(genotox?.kind === 'cited-flags' && genotox.flags[0]?.severity).toBeNull();
    expect(genotox?.kind === 'cited-flags' && genotox.subject).toBe('genotox');
  });

  it('finds a solvent ranking through the three envelopes a durable job wraps it in', () => {
    // `ConnectorJobResult` -> `XtbJobResult` -> `SolventComparisonResult`. No detector knows about
    // any of them; the candidate chain does.
    const detected = detectResult('compare_solvents', SOLVENTS);
    expect(detected?.kind).toBe('ranked');
    if (detected?.kind !== 'ranked') return;
    expect(detected.items.map((item) => item.label)).toEqual([
      'acetonitrile',
      'toluene',
      'gas phase',
    ]);
    // The difference from the leader, because the manifest says the differences are the
    // trustworthy part and any single value carries the method's full error.
    expect(detected.items.map((item) => item.score)).toEqual(['0', '+1.8', '+4']);
    expect(detected.framingIsWarning).toBe(false);
  });

  it('warns when the spread does not exceed the method’s own uncertainty', () => {
    const noisy = structuredClone(SOLVENTS);
    noisy.data.solvents.spread_kcal = 0.4;
    const detected = detectResult('compare_solvents', noisy);
    expect(detected?.kind === 'ranked' && detected.framingIsWarning).toBe(true);
    expect(detected?.kind === 'ranked' && detected.framing).toMatch(/has not distinguished them/);
  });

  it('carries a search’s own verdict rather than rewording it', () => {
    const unbuilt = { ...SIMILAR, hits: [], index_empty: true, verdict: 'SEARCH NOT RUN: …' };
    const detected = detectResult('similar_molecules', unbuilt);
    // "nothing is indexed" and "we have no precedent" are opposite answers, and the payload is
    // careful about which it is giving. Paraphrasing here would re-decide that.
    expect(detected?.kind === 'ranked' && detected.framing).toBe('SEARCH NOT RUN: …');
    expect(detected?.kind === 'ranked' && detected.framingIsWarning).toBe(true);
  });

  it('reads a value with its uncertainty, and refuses a tool it has no field map for', () => {
    const pka = detectResult('predict_pka', PKA);
    expect(pka?.kind === 'value' && [pka.value, pka.uncertainty]).toEqual([4.76, 0.62]);
    // The one place a tool name is consulted. An unmapped tool falls through to the raw preview
    // rather than guessing which number in the payload is the answer.
    expect(detectResult('predict_logd', { smiles: 'CCO', logd: 1.2, uncertainty: 0.3 })).toBeNull();
  });

  it('keeps "no uncertainty stated" apart from an uncertainty of zero', () => {
    // `XtbResult` carries no uncertainty field. Rendering `± 0` would claim the energy is exact.
    const detected = detectResult('compute_xtb_energy', XTB);
    expect(detected?.kind === 'value' && detected.uncertainty).toBeNull();
  });

  it('prefers the uniform estimate, which is the only shape carrying the domain answer', () => {
    const detected = detectResult('predict_solubility', SOLUBILITY);
    expect(detected?.kind === 'value' && detected.inDomain).toBe(false);
    expect(detected?.kind === 'value' && detected.uncertaintyBasis).toBe(
      'the model’s own reported error',
    );
    // The calculator's own spelling of the same number is not repeated as an "other field".
    expect(
      detected?.kind === 'value' && detected.extras.some((e) => e.label.includes('log s')),
    ).toBe(false);
  });

  it('refuses a flag list that lost a row on the way in', () => {
    // A silently shortened list is the failure the backend refuses over-cap results whole to
    // avoid: half a screen is still valid JSON and renders as a complete one with flags missing.
    const damaged = {
      ...HAZARDS,
      flags: [HAZARDS.flags[0], { rule_id: 'x', severity: 'high', matched: 'CCO' }],
    };
    expect(detectResult('screen_hazards', damaged)).toBeNull();
  });

  it('returns null for text that is not a result at all', () => {
    for (const payload of [null, 'calc-compare_solvents-0123456789abcdef', 42, {}, []]) {
      expect(detectResult('screen_hazards', payload), JSON.stringify(payload)).toBeNull();
    }
  });
});

describe('the cited-flag renderer', () => {
  it('shows every flag’s explanation, citation and what it matched', () => {
    const detected = detectResult('screen_hazards', HAZARDS);
    if (detected?.kind !== 'cited-flags') throw new Error('not detected');
    render(<CitedFlags result={detected} />);

    expect(screen.getByText(/A strong oxidant charged alongside/)).toBeTruthy();
    expect(screen.getByText(/Bretherick’s Handbook, 7th ed., 1.4/)).toBeTruthy();
    expect(screen.getByText(/matched CCO \+ CC\(=O\)O/)).toBeTruthy();
    expect(screen.getByText('high')).toBeTruthy();
    expect(screen.getByText(/2 hazard rule\(s\) matched/)).toBeTruthy();
  });

  it('still renders the verdict when nothing matched, and never the word "safe"', () => {
    const detected = detectResult('screen_hazards', CLEAN_SCREEN);
    if (detected?.kind !== 'cited-flags') throw new Error('not detected');
    const { container } = render(<CitedFlags result={detected} />);

    // The empty case is the dangerous one: an over-trusted screen converts an absence of knowledge
    // into apparent assurance, and a live run had a chemist told "no hazards detected" six times.
    expect(screen.getByText(/This is not a safety assessment/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/\bsafe\b/i);
    // And it names what it looked at, which is what `screened` was added for.
    expect(screen.getByText('Screened structure')).toBeTruthy();
  });

  it('does not cut a charged SMILES in half looking for a pair', async () => {
    // `matched` is `"a + b"` for an incompatibility pair and a lone structure otherwise — and a
    // SMILES is full of bare `+` signs. Splitting on one would hand a renderer two fragments of an
    // azide and draw whichever of them happened to parse.
    const azide = {
      flags: [
        {
          rule_id: 'organic-azide',
          severity: 'high',
          explanation: 'Organic azides are energetic and shock-sensitive.',
          citation: 'Bretherick’s Handbook, 7th ed., 2.2',
          matched: 'CCN=[N+]=[N-]',
        },
      ],
      screened: ['CCN=[N+]=[N-]', 'CCO'],
      verdict: '1 hazard rule(s) matched (most serious: high). Advisory only.',
    };
    const detected = detectResult('screen_hazards', azide);
    if (detected?.kind !== 'cited-flags') throw new Error('not detected');
    const { container } = render(<CitedFlags result={detected} />);

    // Two structures were screened, so the flag redraws what it fired on — whole, and marked
    // unreadable rather than silently replaced when the renderer cannot read it.
    await waitFor(() => expect(container.textContent).toMatch(/CCN=\[N\+\]=\[N-\]/));
    expect(container.textContent).not.toMatch(/CCN=\[N\s*$/);
  });

  it('draws the structures the screen covered, from the payload', async () => {
    const detected = detectResult('screen_genotoxic_alerts', GENOTOX);
    if (detected?.kind !== 'cited-flags') throw new Error('not detected');
    const { container } = render(<CitedFlags result={detected} />);

    // From `screened` — the canonical SMILES the backend echoes — never from the preview, which is
    // cut at an arbitrary byte and whose truncated SMILES often parses as a smaller, wrong
    // molecule.
    await waitFor(() =>
      expect(container.querySelector('svg[data-smiles="c1ccccc1"]')).toBeTruthy(),
    );
    // No severity chip: the alert tables do not rank, so this card must not either.
    expect(screen.queryByText('high')).toBeNull();
    expect(screen.getByText('alert')).toBeTruthy();
  });
});

describe('the ranked-comparison renderer', () => {
  it('frames a solvent screen as a ranking, with the leader first', () => {
    const detected = detectResult('compare_solvents', SOLVENTS);
    if (detected?.kind !== 'ranked') throw new Error('not detected');
    render(<Ranked result={detected} />);

    expect(screen.getByText('acetonitrile')).toBeTruthy();
    expect(screen.getByText('ΔΔG vs acetonitrile (kcal/mol)')).toBeTruthy();
    expect(screen.getByText(/Read the differences, not the absolute values/)).toBeTruthy();
    // The absolute is kept, one step down, because a chemist may still want it.
    expect(screen.getByText('ΔG -3.6 kcal/mol')).toBeTruthy();
  });

  it('draws a similarity hit’s structure and cites the note it names', async () => {
    const detected = detectResult('similar_molecules', SIMILAR);
    if (detected?.kind !== 'ranked') throw new Error('not detected');
    const { container } = render(<Ranked result={detected} />);

    expect(screen.getByText('compound-4-bromoanisole')).toBeTruthy();
    expect(screen.getByText('0.87')).toBeTruthy();
    await waitFor(() =>
      expect(container.querySelector('svg[data-smiles="COc1ccc(Br)cc1"]')).toBeTruthy(),
    );
  });
});

describe('the row-table renderer', () => {
  it('renders a bench-ready charge table', () => {
    const detected = detectResult('stoichiometry_table', CHARGE_TABLE);
    if (detected?.kind !== 'rows') throw new Error('not detected');
    render(<RowTable result={detected} />);

    expect(screen.getByText('phenylboronic acid')).toBeTruthy();
    expect(screen.getByText('11.13')).toBeTruthy();
    expect(screen.getByText(/Basis: 4-bromoanisole, 1.87 g/)).toBeTruthy();
  });

  it('says loudly that a reagent is in no row', () => {
    const detected = detectResult('stoichiometry_table', CHARGE_TABLE);
    if (detected?.kind !== 'rows') throw new Error('not detected');
    render(<RowTable result={detected} />);

    // A chemist reading three rows cannot see that a fourth was asked for. A silently dropped
    // reagent does not make the table incomplete, it makes it wrong.
    const notice = screen.getByText(/Pd\(dppf\)Cl2/);
    expect(notice.textContent).toMatch(/not the whole charge/);
    expect(notice.className).toMatch(/danger/);
  });

  it('keeps an ICH miss distinct from a limit of zero', () => {
    const detected = detectResult('ich_impurity_limit', ICH_MISS);
    if (detected?.kind !== 'rows') throw new Error('not detected');
    render(<RowTable result={detected} />);

    expect(screen.getByText(/does not carry the number — not that no limit exists/)).toBeTruthy();
  });

  it('renders a limit row with its basis and unit', () => {
    const detected = detectResult('ich_impurity_limit', ICH_HIT);
    if (detected?.kind !== 'rows') throw new Error('not detected');
    render(<RowTable result={detected} />);

    expect(screen.getByText('890')).toBeTruthy();
    expect(screen.getByText('mg/day')).toBeTruthy();
    expect(screen.getByText(/ICH Q3C\(R8\) · Class 2/)).toBeTruthy();
  });

  it('renders calibration residuals signed, and does not call an unclaimed sigma a miss', () => {
    const detected = detectResult('calculator_outliers', OUTLIERS);
    if (detected?.kind !== 'rows') throw new Error('not detected');
    render(<RowTable result={detected} />);

    expect(screen.getByText('-1')).toBeTruthy();
    // `within_uncertainty: null` means the prediction claimed no uncertainty. Rendering it as
    // "no" would report a miss the calculator never had the chance to have.
    expect(screen.getByText('not claimed')).toBeTruthy();
  });
});

describe('the value renderer', () => {
  it('puts the uncertainty on the value line', () => {
    const detected = detectResult('predict_pka', PKA);
    if (detected?.kind !== 'value') throw new Error('not detected');
    render(<ValueCard result={detected} />);

    const value = screen.getByText(/4.76/);
    expect(value.textContent).toMatch(/± 0.62/);
    expect(value.textContent).toMatch(/pKa units/);
    // The site is not dropped just because the card did not model it.
    expect(screen.getByText('acid')).toBeTruthy();
  });

  it('says an absent uncertainty is absent rather than showing none', () => {
    const detected = detectResult('compute_xtb_energy', XTB);
    if (detected?.kind !== 'value') throw new Error('not detected');
    render(<ValueCard result={detected} />);

    expect(screen.getByText(/No uncertainty stated by this calculator/)).toBeTruthy();
  });

  it('marks an out-of-domain number as one that does not describe the molecule', () => {
    const detected = detectResult('predict_solubility', SOLUBILITY);
    if (detected?.kind !== 'value') throw new Error('not detected');
    render(<ValueCard result={detected} />);

    const callout = screen.getByText(/Out of this calculator’s applicability domain/);
    expect(callout.textContent).toMatch(/does not describe this molecule/);
    expect(callout.className).toMatch(/danger/);
  });
});

describe('reaching the result', () => {
  it('fetches only when the row is expanded, and only once', async () => {
    const get = vi.spyOn(api, 'getToolResult').mockResolvedValue(stored('screen_hazards', HAZARDS));
    render(<TracePanel trace={row('screen_hazards', '{"flags": [{"rule_id": "peroxi', REF)} />);

    // Opening the panel is not asking for the payload. The 200-character preview exists so a whole
    // evidence sweep is never pushed at every consumer, and fetching every result as the panel
    // opened would spend that budget from the other end.
    fireEvent.click(screen.getByText(/Show the agent’s work/));
    expect(get).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Render the full result'));
    await waitFor(() => expect(screen.getByText(/2 hazard rule\(s\) matched/)).toBeTruthy());
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]?.slice(0, 2)).toEqual([SID, REF]);

    // Hiding and reopening is a change of mind, not a new question: the ref addresses immutable
    // bytes, so a second request could only fetch the same ones.
    fireEvent.click(screen.getByText('Hide the card'));
    fireEvent.click(screen.getByText('Render the full result'));
    await waitFor(() => expect(screen.getByText(/2 hazard rule\(s\) matched/)).toBeTruthy());
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('falls back to the preview when there is no ref', async () => {
    // An older backend, a store that is off, a result over the byte cap, a write that failed —
    // one empty value with one meaning, and one thing to do about it.
    const get = vi.spyOn(api, 'getToolResult');
    render(<TracePanel trace={row('screen_hazards', 'ScreenResult(flags=[HazardFlag(rul', '')} />);
    fireEvent.click(screen.getByText(/Show the agent’s work/));

    expect(screen.getByText('ScreenResult(flags=[HazardFlag(rul')).toBeTruthy();
    expect(screen.queryByText('Render the full result')).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('falls back to the preview when the fetch fails', async () => {
    vi.spyOn(api, 'getToolResult').mockRejectedValue(new Error('gone'));
    render(<TracePanel trace={row('screen_hazards', 'ScreenResult(flags=[HazardFlag(rul', REF)} />);
    await expandResult();

    expect(screen.getByText('ScreenResult(flags=[HazardFlag(rul')).toBeTruthy();
    expect(screen.getByText(/could not be read, so this is the truncated preview/)).toBeTruthy();
  });

  it('falls back to the preview for a shape nothing cards, and says which it was', async () => {
    // `find_notes` is real, returns JSON, and has no card. That is a supported outcome, not a
    // failure — and a reader must be able to tell it apart from a fetch that broke.
    vi.spyOn(api, 'getToolResult').mockResolvedValue(
      stored('find_notes', { notes: [{ id: 'compound-4-bromoanisole', title: 'Anisole' }] }),
    );
    render(<TracePanel trace={row('find_notes', '{"notes": [{"id": "compo', REF)} />);
    await expandResult();

    expect(screen.getByText('{"notes": [{"id": "compo')).toBeTruthy();
    expect(screen.getByText(/is not a shape this panel cards/)).toBeTruthy();
  });

  it('falls back to the preview when the stored result is not JSON', async () => {
    // A durable job that outlived its inline wait returns a bare workflow id; a provider that
    // stringified a model returns a Python repr. Neither may throw.
    vi.spyOn(api, 'getToolResult').mockResolvedValue({
      ref: REF,
      tool: 'compare_solvents',
      correlation_id: 'abc123',
      byte_size: 39,
      text: 'calc-compare_solvents-0123456789abcdef',
    });
    render(<TracePanel trace={row('compare_solvents', 'calc-compare_solvents-01', REF)} />);
    await expandResult();

    expect(screen.getByText('calc-compare_solvents-01')).toBeTruthy();
    expect(screen.getByText(/is not a shape this panel cards/)).toBeTruthy();
  });
});
