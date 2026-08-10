/**
 * A reaction is a structure too.
 *
 * A molecule toolkit parses molecules and nothing else, so every reaction SMILES fell through to
 * the raw-string fallback. That is what `similar_reactions` returns and what a `reaction` note
 * carries, which made the one search built around reactions the one search whose hits could not be
 * drawn. RDKit's minimal build ships no reaction object either, so the split stayed in the
 * component when the renderer underneath it was replaced — which is what these assertions pin.
 *
 * The drawing itself is not exercised here (`tests/chem.test.tsx` covers that against the RDKit
 * stub). What is pinned is the split: which components a reaction is decomposed into, and that the
 * whole thing carries one accessible name rather than a list of unrelated structures.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Molecule } from '../src/components/Molecule.tsx';

afterEach(cleanup);

describe('Molecule', () => {
  it('names a single structure by its SMILES', () => {
    render(<Molecule smiles="CCO" />);
    expect(screen.getByRole('img', { name: /Chemical structure for SMILES CCO/ })).toBeTruthy();
  });

  it('draws a reaction as its components, under one name', () => {
    // `>` cannot occur inside a molecule SMILES, so the test is exact rather than heuristic.
    render(<Molecule smiles="Brc1ccccc1.OB(O)c1ccccc1>>c1ccc(-c2ccccc2)cc1" />);

    const reaction = screen.getByRole('img', { name: /^Reaction / });
    expect(reaction).toBeTruthy();
    // Three components: two reactants and one product. Each is a structure in its own right.
    expect(screen.getAllByRole('img', { name: /Chemical structure/ })).toHaveLength(3);
  });

  it('puts the agents over the arrow, where a chemist reads them', () => {
    render(<Molecule smiles="CC(=O)O>[Pd]>CC(=O)OC" />);
    expect(screen.getByText('[Pd]')).toBeTruthy();
  });

  it('handles a two-part reaction with nothing over the arrow', () => {
    render(<Molecule smiles="CCO>>CC=O" />);
    expect(screen.getAllByRole('img', { name: /Chemical structure/ })).toHaveLength(2);
  });
});
