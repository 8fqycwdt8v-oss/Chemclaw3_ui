/**
 * A citation resolves to the note it cites.
 *
 * It used to be a prompt button: clicking one dropped "Expand note-123 —…" into the composer and
 * cost the chemist another turn to read what the last one had already cited. `GET /notes/{id}`
 * exists now, so the chip opens the note.
 *
 * The two properties worth pinning are the honest ones rather than the happy path. **Provenance**
 * — a note carries who wrote it, what it came from, and a validity window, and the window is the
 * one a reader cannot infer: the graph stops retrieving an expired note but still serves it here,
 * so a citation in an old answer can resolve to a note that no longer holds. And **the fallback**
 * — not every chip is a note id, so a failed lookup has to land somewhere other than a dead end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CitationChip } from '../src/components/CitationChip.tsx';
import { stubFetch } from './helpers.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
}));

const note = (over: Record<string, unknown> = {}) => ({
  note: {
    id: 'note-suzuki-42',
    type: 'reaction',
    compound_smiles: '',
    tags: ['suzuki'],
    created_by: 'agent',
    source: 'eln-ord',
    confidence: 0.82,
    valid_from: '2026-01-01T00:00:00Z',
    valid_to: null,
    ...over,
  },
  body: 'Ran in 2-MeTHF at 70 °C, 92% isolated.',
  neighbors: [
    {
      id: 'note-brettphos',
      type: 'compound',
      compound_smiles: '',
      tags: [],
      created_by: 'agent',
      source: 'graph',
      confidence: 1,
      valid_from: null,
      valid_to: null,
    },
  ],
});

let restore: (() => void) | null = null;

const serve = (body: unknown, status = 200): void => {
  const stub = stubFetch(
    () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  restore = stub.restore;
};

/** Render a chip and click it, which is the only way the panel is reachable. */
const openChip = (id = 'note-suzuki-42', kind = 'note'): void => {
  render(<CitationChip kind={kind} id={id} />);
  fireEvent.click(screen.getByRole('button', { name: id }));
};

beforeEach(cleanup);
afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

describe('CitationChip', () => {
  it('opens the note it names, with its body', async () => {
    serve(note());
    openChip();
    expect(await screen.findByText('Ran in 2-MeTHF at 70 °C, 92% isolated.')).toBeTruthy();
  });

  it('shows the provenance a reviewer needs, not just the text', async () => {
    serve(note());
    openChip();
    await screen.findByText('Ran in 2-MeTHF at 70 °C, 92% isolated.');

    expect(screen.getByText('eln-ord')).toBeTruthy();
    expect(screen.getByText('agent')).toBeTruthy();
    expect(screen.getByText('0.82')).toBeTruthy();
  });

  it('warns when the note’s validity window has closed', async () => {
    // The case a reader cannot see for themselves: the graph would no longer retrieve this note,
    // but an answer written last year cited it while it still held.
    serve(note({ valid_to: '2026-02-01T00:00:00Z' }));
    openChip();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/no longer retrieves it/)).toBeTruthy();
  });

  it('does not warn about a note with no end date', async () => {
    serve(note());
    openChip();
    await screen.findByText('Ran in 2-MeTHF at 70 °C, 92% isolated.');

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lists linked notes so the graph can be walked', async () => {
    serve(note());
    openChip();

    expect(await screen.findByRole('button', { name: /note-brettphos/ })).toBeTruthy();
  });

  it('offers to ask the agent when the reference is not a readable note', async () => {
    // A `qm-…` chip names a job whose note may never have been written. The pre-route behaviour
    // is the right answer there, so it survives as the failure path rather than as the default.
    serve({ detail: 'not found' }, 404);
    const prefilled: string[] = [];
    window.addEventListener('chemclaw:prefill', (e) =>
      prefilled.push(String((e as CustomEvent<string>).detail)),
    );

    openChip('qm-job-7', 'qm');
    fireEvent.click(await screen.findByRole('button', { name: /ask the agent/i }));

    expect(prefilled[0]).toContain('qm-job-7');
  });

  it('does not fetch anything until the chip is clicked', () => {
    // An answer can carry a dozen citations; resolving all of them to render one is the cost this
    // design exists to avoid.
    const stub = stubFetch(() => new Response('{}', { status: 200 }));
    restore = stub.restore;
    render(<CitationChip kind="note" id="note-1" />);

    expect(stub.calls).toHaveLength(0);
  });
});
