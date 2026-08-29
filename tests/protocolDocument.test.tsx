/**
 * The document view, and the one thing it must not blur.
 *
 * A protocol reaches a chemist as a mixture of what they asked for and what the agent filled in,
 * and `RequestField.basis` is the only thing on the wire that tells the two apart. An inferred
 * scale rendered like a stated one is the agent's guess wearing the chemist's authority — and a
 * scale is a vessel charge. So the chips are pinned here, in all three states, and so is the
 * quote that lets a reader check a transcription rather than trust it.
 *
 * The second property is the stale-revision notice. Opening revision 2 of a design that is on 4
 * with nothing saying so means every number on the page is read as current, which is how a
 * superseded protocol gets run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ProtocolDocument } from '../src/components/ProtocolDocument.tsx';
import { stubFetch } from './helpers.ts';
import type {
  DesignRevision,
  DesignSummary,
  RevisionSummary,
  StatusEvent,
} from '../shared/protocols.ts';

vi.mock('../src/auth/AuthContext.tsx', () => {
  const value = { auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true };
  return { useAuth: () => value, useIsReviewer: () => true };
});

const DESIGN = 'design-0123456789ab';

const SUMMARY: DesignSummary = {
  design_id: DESIGN,
  title: 'Amination solvent screen',
  mode: 'screen',
  status: 'draft',
  project: 'PRJ-4',
  opened_by: 'chemist@example.com',
  head_revision: 4,
  arms: 1,
  blockers: 1,
  created_at: '2026-08-20T09:00:00Z',
  updated_at: '2026-08-21T09:00:00Z',
};

/** Typed against the declaration, so a renamed field fails `tsc -b` rather than this fixture. */
const revision = (at: number): DesignRevision => ({
  design_id: DESIGN,
  revision: at,
  kind: 'protocol',
  author_kind: 'agent',
  author: 'chemclaw',
  change_note: 'Drafted from the structured request.',
  checks: [
    { check_id: 'plate-fits', severity: 'blocker', passed: false, detail: '8 arms, 6 wells.' },
    {
      check_id: 'charge-complete',
      severity: 'note',
      passed: true,
      detail: 'Every species charged.',
    },
  ],
  created_at: '2026-08-21T09:00:00Z',
  design: {
    request: {
      title: 'Amination solvent screen',
      goal: 'Keep selectivity above 9:1.',
      mode: 'screen',
      reaction_smiles: '',
      components: [],
      objectives: [],
      // One of each basis, which is the whole point of this fixture.
      scale: { value: '250 mg', basis: 'stated', quote: 'run it on 250 mg of the bromide' },
      plate_format: { value: '24', basis: 'inferred', quote: '' },
      max_runs: { value: '', basis: 'absent', quote: '' },
      deadline: { value: '', basis: 'absent', quote: '' },
      forbidden: [],
      prior_work: '',
      project: 'PRJ-4',
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
      expected: { yield_percent: 72, selectivity: '9:1', basis: 'assumed', detail: '' },
    },
    factors: [],
    arms: [],
    layout: null,
    evidence: [],
  },
});

/** What `GET /protocols/{id}` carries about who signed off, and on which revision. */
const SIGN_OFFS: StatusEvent[] = [
  {
    status: 'approved',
    revision: 2,
    actor: 'chemist@example.com',
    reason: 'The precedent runs at 80 °C.',
    created_at: '2026-08-21T10:00:00Z',
  },
];

const HISTORY: RevisionSummary[] = [
  {
    revision: 4,
    kind: 'protocol',
    author_kind: 'human',
    author: 'chemist@example.com',
    change_note: 'Raised the temperature.',
    created_at: '2026-08-22T09:00:00Z',
    blockers: 0,
  },
  {
    revision: 2,
    kind: 'protocol',
    author_kind: 'agent',
    author: 'chemclaw',
    change_note: 'Drafted from the structured request.',
    created_at: '2026-08-21T09:00:00Z',
    blockers: 1,
  },
];

let restore: (() => void) | null = null;
/** Which revision the service answers with — the head unless the URL asked for another. */
let served = 4;

function serve(): void {
  const stub = stubFetch((url) => {
    if (url.includes('/protocols?') || url.endsWith('/protocols')) {
      return new Response(JSON.stringify({ designs: [SUMMARY] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const asked = new URL(url, 'http://x').searchParams.get('revision');
    // FLAT, and spread from the revision, because that is what `GET /protocols/{id}` returns. This
    // stub used to nest it under `revision:`, agreeing with a type this app invented and with
    // nothing the service sends — so every assertion below passed while the real page threw on
    // `design.request.title`.
    return new Response(
      JSON.stringify({
        ...revision(asked ? Number(asked) : served),
        summary: SUMMARY,
        history: HISTORY,
        status_history: SIGN_OFFS,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  restore = stub.restore;
}

function open(): void {
  render(
    <MemoryRouter initialEntries={[`/protocols/${DESIGN}`]}>
      <Routes>
        <Route path="/protocols/:designId" element={<ProtocolDocument />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  served = 4;
});
afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

describe('ProtocolDocument', () => {
  it('tells an inferred field from a stated one, and an absent one from both', async () => {
    serve();
    open();

    // Spelled out, not a quiet grey chip: a reader who skims past this is agreeing to a number
    // nobody asked for.
    expect(await screen.findByText(/inferred — nobody stated this/)).toBeTruthy();
    expect(screen.getByText('stated')).toBeTruthy();
    // Two absent fields — `max_runs` and `deadline` — each said rather than left blank.
    expect(screen.getAllByText('not stated')).toHaveLength(2);
  });

  it('offers the chemist’s own words on a control a keyboard can reach', async () => {
    // A tooltip on a bare <span> is unreachable from a keyboard, which for the one control that
    // lets a reader *check* a transcription loses the wrong half of the audience.
    serve();
    open();

    const trigger = await screen.findByRole('button', {
      name: /Scale was stated — show the words it was read from/,
    });
    expect(trigger.tagName).toBe('BUTTON');
  });

  it('leads with a blocker rather than with the document', async () => {
    serve();
    open();
    // The strip, not the history row that also counts one — both say it, and the one above the
    // document is the one a reader meets first.
    const strip = await screen.findByRole('region', { name: 'Checks' });
    expect(within(strip).getByText('1 blocker')).toBeTruthy();
    expect(within(strip).getByText('8 arms, 6 wells.')).toBeTruthy();
    // A check that passed is not listed: the strip is what failed, and a list of everything that
    // went right is what makes a reader stop reading it.
    expect(within(strip).queryByText('Every species charged.')).toBeNull();
  });

  it('says when the revision on screen is not the current one, and withholds Edit', async () => {
    // Every number on this page is read as current unless something says otherwise — which is how
    // a superseded protocol gets run. Editing an old revision would be refused as a conflict,
    // which is the right answer and a confusing way to learn it.
    served = 2;
    serve();
    open();

    expect(await screen.findByText(/You are reading revision 2/)).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Edit this protocol/ }).hasAttribute('disabled'),
      ).toBe(true),
    );
  });

  it('shows the design’s status from the read itself, not from a second request', async () => {
    // The header row rides along with the document, so the badge costs no extra round trip. This
    // test's own name used to say the opposite — "since the document route does not carry one" —
    // which was the invented contract talking.
    serve();
    open();
    expect(await screen.findByText('draft')).toBeTruthy();
  });

  it('names who signed off and on which revision, which the badge cannot', async () => {
    // A revision landing on an approved design demotes it back to `draft`, so the status badge is
    // about the head and the sign-off is about a document. Only this line can say the chemist
    // approved revision 2 — and only rendering it makes the reason worth storing.
    serve();
    open();
    // Matched on the whole row rather than on a string: the status, the revision and the reason
    // are three elements, and a text query for the sentence would find none of them.
    const row = await screen.findByText(
      (_content, element) =>
        element?.tagName === 'LI' && /approved.*revision 2/s.test(element.textContent ?? ''),
    );
    expect(row.textContent).toContain('chemist@example.com');
    expect(row.textContent).toContain('The precedent runs at 80 °C.');
  });
});
