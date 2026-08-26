/**
 * What every chemistry surface says when RDKit is not there.
 *
 * Its own docstring names the live path: instantiating the WASM needs `script-src
 * 'wasm-unsafe-eval'`, and a missing directive fails *only* behind the BFF — so "the toolkit did
 * not load" is a deployment away, not a hypothetical.
 *
 * The failure this file exists to stop is not the missing drawing. It is that "RDKit is not here"
 * and "this is not a molecule" were the same `null`, so the panel told a chemist that `CCO` is not
 * a molecule and the composer's paste check simply stopped happening — silently, for the page's
 * lifetime, with no retry.
 *
 * A whole file of its own because `loadRDKit` memoises per module registry, and the mock has to be
 * in place before the first import.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FIELD_PLACEHOLDER, StructureInput } from '../src/components/StructureInput.tsx';
import { Composer } from '../src/components/Composer.tsx';
import { Molecule } from '../src/components/Molecule.tsx';
import { canonicalSmiles, rdkitAvailable } from '../src/chem/rdkit.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import { pasteInto } from './helpers.ts';

/** Counted, because "does it try again" is the other half of the finding. */
const init = vi.hoisted(() => ({ calls: 0 }));

vi.mock('@rdkit/rdkit', () => ({
  default: async () => {
    init.calls += 1;
    // What a blocked `wasm-unsafe-eval` looks like from here.
    throw new Error('WebAssembly.instantiate is not allowed by the page CSP');
  },
}));

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
}));

vi.mock('../src/api/client.ts', () => ({
  api: { listProfiles: async () => [], uploadAttachment: vi.fn() },
}));

const field = (): HTMLInputElement =>
  screen.getByPlaceholderText(FIELD_PLACEHOLDER) as HTMLInputElement;

beforeEach(() => {
  cleanup();
  init.calls = 0;
  useChatStore.setState({ composerLock: false, streaming: null, drafts: {}, banner: null });
});

afterEach(cleanup);

describe('the loader', () => {
  it('says it is unavailable, and does not memoise the failure', async () => {
    expect(await rdkitAvailable()).toBe(false);
    const first = init.calls;
    expect(first).toBeGreaterThan(0);

    // A CSP that was fixed, a chunk that arrived on the second try, a network blip: none of them
    // is a property of the input, and caching the `null` left the page unable to read a structure
    // for its whole lifetime.
    expect(await canonicalSmiles('CCO')).toBeNull();
    expect(init.calls).toBeGreaterThan(first);
  });
});

describe('the structure panel', () => {
  it('says the toolkit is missing rather than calling ethanol unreadable', async () => {
    render(<StructureInput onAccept={vi.fn()} onClose={vi.fn()} />);

    fireEvent.change(field(), { target: { value: 'CCO' } });

    expect(await screen.findByText(/structure toolkit could not be loaded/i)).toBeTruthy();
    // The one thing it must never say about a perfectly good SMILES.
    expect(screen.queryByText('RDKit could not read this as a molecule.')).toBeNull();
    // And nothing is insertable: the confirmation is the drawing, and there is no drawing.
    expect(screen.queryByText('Insert')).toBeNull();
  });
});

describe('the composer', () => {
  it('says why a paste was not checked, instead of falling silent', async () => {
    render(<Composer conversationId="c1" />);

    pasteInto(screen.getByLabelText('Message') as HTMLTextAreaElement, 'COc1ccc(Br)cc1', 0);

    const strip = await screen.findByRole('alert');
    expect(strip.textContent).toMatch(/structure toolkit could not be loaded/i);
    // Not a chemical verdict about the string: it is a perfectly good molecule and nothing here
    // is entitled to an opinion about it.
    expect(strip.textContent).not.toMatch(/could not read this as a molecule/i);
  });
});

describe('a drawing', () => {
  it('blames the toolkit rather than the structure', async () => {
    render(<Molecule smiles="CCO" />);

    await waitFor(() =>
      expect(screen.getByText(/structure toolkit could not be loaded/i)).toBeTruthy(),
    );
    // The string still shows — it is what the chemist can copy elsewhere while this is broken.
    expect(screen.getByText('CCO')).toBeTruthy();
  });
});
