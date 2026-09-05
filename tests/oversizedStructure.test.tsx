/**
 * What a surface says about a molecule this app declines to parse.
 *
 * `MAX_PARSED_SMILES_CHARS` exists because RDKit's WASM traps unrecoverably on a long enough chain
 * — measured against the shipped binary, 1,100 characters raises `memory access out of bounds` and
 * every later call into the module throws too. The cap is 600, deliberately ~40% below that.
 *
 * Which leaves a gap, and the gap is what this file is about. Re-measured on 2026-09-05: 600
 * characters parse and draw, 800 do, 1,000 do (2.4 s, 504 kB of SVG), 1,040 parses with the *draw*
 * throwing and the runtime alive. So every string from 601 to ~1,099 characters is a molecule RDKit
 * can read and this module chooses not to — a PEG linker or a polymer written out longhand, which
 * `looksLikeSmiles` already accepts as `'CC'.repeat(600)`.
 *
 * Both surfaces answered that refusal with a chemical verdict: "Could not render this structure"
 * and "RDKit could not read this as a molecule". That is the same collapse `rdkitAvailable()` was
 * written to undo one layer down — a fact about this page reported as a fact about the compound —
 * and it is asserted here rather than in `rdkitTrap.test.ts` because the defect is the sentence,
 * not the `null`.
 *
 * Its own file for the reason the other RDKit files have one: `loadRDKit` memoises per module
 * registry, so the mock has to be in place before the first import.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { FIELD_PLACEHOLDER, StructureInput } from '../src/components/StructureInput.tsx';
import { Molecule } from '../src/components/Molecule.tsx';
import { MAX_PARSED_SMILES_CHARS } from '../src/chem/rdkit.ts';
import { pasteInto } from './helpers.ts';

/** A toolkit that works perfectly. The refusal under test is entirely ours. */
vi.mock('@rdkit/rdkit', () => {
  const mol = (smiles: string) => ({
    is_valid: () => true,
    get_smiles: () => smiles,
    normalize_depiction: () => {},
    straighten_depiction: () => {},
    get_svg_with_highlights: () => `<svg data-smiles="${smiles}"></svg>`,
    delete: () => {},
  });
  return { default: async () => ({ get_mol: (smiles: string) => mol(smiles) }) };
});

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
}));

vi.mock('../src/api/client.ts', () => ({
  api: { listProfiles: async () => [], uploadAttachment: vi.fn() },
}));

/** Inside the readable range and outside the parsed one — the whole subject of this file. */
const POLYMER = 'C'.repeat(700);

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  cleanup();
});

describe('a structure past the parse cap', () => {
  it('is described as too large to draw, not as unreadable', async () => {
    render(<Molecule smiles={POLYMER} />);

    await waitFor(() => {
      expect(screen.getByText(/too large to draw here/)).toBeTruthy();
    });
    // Both numbers, because "too large" with no scale is not something a chemist can act on.
    expect(screen.getByText(new RegExp(`${POLYMER.length} characters`))).toBeTruthy();
    expect(screen.getByText(new RegExp(`limit of ${MAX_PARSED_SMILES_CHARS}`))).toBeTruthy();
    // The claim that used to be made instead.
    expect(screen.queryByText(/Could not render this structure/)).toBeNull();
  });

  it('draws the longest string that is still inside the cap', async () => {
    // The boundary is inclusive, and pinning it here is what keeps the new branch from swallowing
    // the case it was carved out of: at exactly the cap there is a drawing, so a chemist gets the
    // structure rather than a notice about a limit they have not reached.
    render(<Molecule smiles={'C'.repeat(MAX_PARSED_SMILES_CHARS)} />);
    await waitFor(() => {
      expect(document.querySelector('svg[data-smiles]')).toBeTruthy();
    });
    expect(screen.queryByText(/too large to draw here/)).toBeNull();
  });
});

describe('the structure panel, handed the same string', () => {
  it('says it will not parse it rather than that RDKit could not read it', async () => {
    render(<StructureInput onAccept={vi.fn()} onClose={vi.fn()} />);

    pasteInto(screen.getByPlaceholderText(FIELD_PLACEHOLDER) as HTMLInputElement, POLYMER);

    await waitFor(() => {
      expect(screen.getByText(/longer than this panel will parse/)).toBeTruthy();
    });
    expect(screen.queryByText(/could not read this as a molecule/)).toBeNull();
  });
});
