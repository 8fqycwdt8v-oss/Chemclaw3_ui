/**
 * Correcting a protocol, and the one failure that has to be handled honestly.
 *
 * Two chemists editing one design is the ordinary case in a lab, and it is the reason a save posts
 * the `parent_revision` it was written against rather than "whatever the head is now". The service
 * refuses with a 409, and what this screen does next is the whole test: **say that somebody else
 * edited it, offer the re-read, and never re-post the same values against the new parent** — which
 * would discard their work while telling this chemist theirs succeeded. It is the same handling
 * `decidePlan`'s `plan_changed` gets, for the same reason.
 *
 * The rest is the repository's existing convention for an attributable write, checked rather than
 * assumed: a change note is required before Save is live (the review queue's rejection-reason rule)
 * and the write goes through a confirmation.
 *
 * One thing here is not a convention but a defect the obvious implementation has. A controlled
 * `type="number"` bound straight to the document deletes the value halfway through `1.5`: after
 * `1.` the input's own value reads empty, the parse yields `null`, and the re-render clears what
 * was being typed. The last test drives exactly that keystroke.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ProtocolEditor } from '../src/components/ProtocolEditor.tsx';
import { stubFetch } from './helpers.ts';
import type { DesignRevision, ExperimentDesign } from '../shared/protocols.ts';

vi.mock('../src/auth/AuthContext.tsx', () => {
  // Stable identity, as the real context value is: a fresh object per render re-fires every
  // `[auth]` effect, which in a form is a request per keystroke.
  const value = { auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true };
  return { useAuth: () => value, useIsReviewer: () => true };
});

const DESIGN = 'design-0123456789ab';

/** Typed against the declaration, so a renamed field fails `tsc -b` rather than this fixture
 *  quietly describing a document the service no longer sends. */
const DOCUMENT: ExperimentDesign = {
  request: {
    title: 'Amination solvent screen',
    goal: '',
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
    project: '',
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
    charge: [
      {
        component: 'aryl bromide',
        smiles: 'Brc1ccccc1',
        role: 'starting-material',
        equivalents: 1,
        amount_mmol: 1,
        mass_mg: 157,
        volume_ml: null,
        limiting: true,
        note: '',
      },
    ],
    steps: [
      {
        index: 1,
        kind: 'charge',
        text: 'Charge the vessel.',
        components: [],
        temperature_c: null,
        duration_h: null,
      },
    ],
    analytics: [],
    in_process_controls: [],
    hazards: [],
    waste: '',
    expected: { yield_percent: null, selectivity: '', basis: 'assumed', detail: '' },
  },
  factors: [],
  arms: [
    {
      arm_id: 'arm-1',
      levels: { solvent: '2-MeTHF' },
      setpoints: null,
      control: '',
      replicate_of: '',
      note: '',
    },
  ],
  layout: null,
  evidence: [],
};

const REVISION: DesignRevision = {
  design_id: DESIGN,
  revision: 4,
  kind: 'protocol',
  author_kind: 'agent',
  author: 'chemclaw',
  change_note: 'Drafted.',
  design: DOCUMENT,
  checks: [],
  created_at: '2026-08-21T09:00:00Z',
};

let restore: (() => void) | null = null;
let status = 200;
const posts: { url: string; body: unknown }[] = [];

function serve(): void {
  const stub = stubFetch((url, init) => {
    posts.push({ url, body: JSON.parse(String(init?.body)) });
    if (status >= 400) {
      return new Response(
        JSON.stringify({
          detail:
            status === 409 ? 'parent_revision 4 is not the head' : 'the document failed validation',
        }),
        { status, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ revision: 5, checks: [], changed_paths: ['base'] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  restore = stub.restore;
}

function open(handlers: { onSaved?: (r: number) => void; onReload?: () => void } = {}): void {
  render(
    <ProtocolEditor
      designId={DESIGN}
      revision={{ ...REVISION, summary: null, history: [], status_history: [] }}
      open
      onOpenChange={() => {}}
      onSaved={handlers.onSaved ?? (() => {})}
      onReload={handlers.onReload ?? (() => {})}
    />,
  );
}

/** Write a change note and take the save through its confirmation. */
async function save(note = 'Raised the temperature to 100 °C.'): Promise<void> {
  fireEvent.change(screen.getByLabelText(/Change note/), { target: { value: note } });
  fireEvent.click(screen.getByRole('button', { name: 'Save a new revision' }));
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save revision' }));
}

beforeEach(() => {
  cleanup();
  posts.length = 0;
  status = 200;
});
afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

describe('ProtocolEditor', () => {
  it('will not save without a change note', () => {
    // Same rule as the review queue's rejection reason: a revision that moved four setpoints and
    // says nothing about why tells the next reader, and the agent reading this history, nothing.
    serve();
    open();
    expect(
      screen.getByRole('button', { name: 'Save a new revision' }).hasAttribute('disabled'),
    ).toBe(true);

    fireEvent.change(screen.getByLabelText(/Change note/), { target: { value: 'why' } });
    expect(
      screen.getByRole('button', { name: 'Save a new revision' }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('posts the edited document against the revision it was opened on', async () => {
    serve();
    const saved = vi.fn();
    open({ onSaved: saved });

    fireEvent.change(screen.getByLabelText(/Temperature/), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText(/aryl bromide equivalents/), {
      target: { value: '1.15' },
    });
    fireEvent.change(screen.getByLabelText(/Step 1/), { target: { value: 'Charge under N2.' } });
    await save();

    await waitFor(() => expect(posts).toHaveLength(1));
    const body = posts[0]!.body as {
      document: ExperimentDesign;
      parent_revision: number;
      change_note: string;
    };
    expect(posts[0]!.url).toContain(`/protocols/${DESIGN}/revisions`);
    // The revision being edited, never "whatever the head is now" — the whole reason the service
    // can refuse a save built on a document that has since moved.
    expect(body.parent_revision).toBe(4);
    expect(body.document.base.setpoints.temperature_c).toBe(100);
    expect(body.document.base.charge[0]?.equivalents).toBe(1.15);
    expect(body.document.base.steps[0]?.text).toBe('Charge under N2.');
    // Untouched fields survive the round trip: this posts the whole document, so anything it
    // dropped would be silently deleted from the design.
    expect(body.document.base.setpoints.solvent).toBe('2-MeTHF');
    expect(saved).toHaveBeenCalledWith(5);
  });

  it('seeds an arm override from the base rather than unsetting everything else', async () => {
    // An arm with `setpoints: null` runs at the base conditions. Writing a `Setpoints` with one
    // field set and every other one null would silently unset that arm's solvent and atmosphere.
    serve();
    open();

    fireEvent.change(screen.getByLabelText(/arm-1 temperature/), { target: { value: '60' } });
    await save();

    await waitFor(() => expect(posts).toHaveLength(1));
    const body = posts[0]!.body as { document: ExperimentDesign };
    expect(body.document.arms[0]?.setpoints).toMatchObject({
      temperature_c: 60,
      solvent: '2-MeTHF',
      atmosphere: 'N2',
    });
  });

  it('clears the box when the override behind it is cleared', async () => {
    // The input is a draft of the field, not a second source of truth for it. `text` was seeded
    // once and never resynchronised and the arm `<li>` key is stable, so "Clear override" set the
    // arm's setpoints to null while the box went on showing the old number — the form said 60 °C
    // for an arm that would be saved inheriting the base's 80 °C, and the Save posted the null.
    serve();
    open();

    const box = screen.getByLabelText(/arm-1 temperature/) as HTMLInputElement;
    fireEvent.change(box, { target: { value: '60' } });
    expect(box.value).toBe('60');

    fireEvent.click(screen.getByRole('button', { name: /clear override/i }));
    expect((screen.getByLabelText(/arm-1 temperature/) as HTMLInputElement).value).toBe('');
  });

  it('leaves the text a chemist is typing alone, however they spell the number', async () => {
    // The resynchronise above keyed on `value` changing, and `text` and `value` agree as *numbers*
    // while somebody types and not as strings — so every keystroke that moved the parsed value
    // rewrote the box with `String(value)`. Measured through this editor: `1e5` came back
    // `100000`, `05` came back `5`, and inserting a `2` into `1.50` gave `12.5` with the trailing
    // zero gone and the caret thrown to the end. Nothing was ever saved wrong; what was lost is
    // what the chemist was typing.
    serve();
    open();
    const box = screen.getByLabelText(/arm-1 temperature/) as HTMLInputElement;
    for (const typed of ['1e5', '05', '12.50', '1.', '-', '1e']) {
      fireEvent.change(box, { target: { value: typed } });
      expect(box.value).toBe(typed);
    }
  });

  it('says somebody else edited it, offers the re-read, and does not re-post', async () => {
    // The 409 the `parent_revision` exists to produce. Re-posting these values against the new
    // parent would discard whatever landed in between while reporting success.
    status = 409;
    serve();
    const reload = vi.fn();
    const saved = vi.fn();
    open({ onReload: reload, onSaved: saved });

    await save();

    expect(await screen.findByText(/Somebody else edited this/)).toBeTruthy();
    expect(screen.getByText(/Nothing was saved/)).toBeTruthy();
    expect(saved).not.toHaveBeenCalled();
    expect(posts).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Reload the design' }));
    expect(reload).toHaveBeenCalledTimes(1);
    // Still one: the conflict is answered by re-reading, never by a retry this screen makes.
    expect(posts).toHaveLength(1);
  });

  it('reports any other failure as itself, not as a conflict with a colleague', async () => {
    status = 422;
    serve();
    open();
    await save();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/Somebody else edited this/)).toBeNull();
  });

  it('keeps a half-typed decimal instead of deleting it mid-keystroke', async () => {
    // `1.` parses to nothing, and a field that wrote `null` there would clear what the chemist was
    // typing on the way to `1.5`. The text is local; the document only moves when it parses.
    serve();
    open();

    const field = screen.getByLabelText(/aryl bromide equivalents/) as HTMLInputElement;
    fireEvent.change(field, { target: { value: '1.' } });
    expect(field.value).toBe('1.');
    fireEvent.change(field, { target: { value: '1.5' } });
    await save();

    await waitFor(() => expect(posts).toHaveLength(1));
    const body = posts[0]!.body as { document: ExperimentDesign };
    expect(body.document.base.charge[0]?.equivalents).toBe(1.5);
  });

  it('reads an emptied field as unset rather than as zero', async () => {
    // An unstated pressure is not one bar and an unstated pH is not neutral, so an empty field has
    // to reach the service as `null` and not as `0`.
    serve();
    open();

    fireEvent.change(screen.getByLabelText(/^Time/), { target: { value: '' } });
    await save();

    await waitFor(() => expect(posts).toHaveLength(1));
    const body = posts[0]!.body as { document: ExperimentDesign };
    expect(body.document.base.setpoints.time_h).toBeNull();
  });
});
