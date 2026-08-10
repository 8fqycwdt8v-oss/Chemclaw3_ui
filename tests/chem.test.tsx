/**
 * The chemistry layer: what counts as a structure, and what gets drawn.
 *
 * Two halves, deliberately separate. `src/chem/recognise.ts` is pure syntax and is tested as such;
 * `src/chem/rdkit.ts` is tested through the behavioural stub aliased in `vitest.config.ts`.
 *
 * The rule these exist to defend: a truncated SMILES frequently remains *valid* as a smaller,
 * different molecule. Prose cut short reads as cut short; a structure cut short reads as a
 * structure, and nothing downstream can catch it. So nothing may be drawn from
 * `tool_result.preview`, and `smilesFromArguments` refusing an incomplete JSON document is the
 * mechanism that enforces it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import {
  looksLikeCompoundName,
  looksLikeReactionSmiles,
  looksLikeSmiles,
  smilesFromArguments,
} from '../src/chem/recognise.ts';
import { canonicalSmiles, isMolecule, moleculeSvg } from '../src/chem/rdkit.ts';
import { Molecule } from '../src/components/Molecule.tsx';
import { liveHandles, resetHandles } from './stubs/rdkit.ts';

beforeEach(() => {
  cleanup();
  resetHandles();
});

afterEach(cleanup);

describe('looksLikeSmiles', () => {
  it('accepts real molecules', () => {
    // `CCO` first, because it is the regression. The rule this replaces demanded a bracket, a
    // digit or a bond character, so ethanol — and every other straight-chain molecule — was never
    // offered a structure. Two-character molecules stay out: `CC` and `CO` collide with prose far
    // too often to be worth the one real structure each would catch.
    for (const s of ['CCO', 'CCN', 'CCC', 'CC(=O)O', 'COc1ccc(Br)cc1', 'c1ccccc1']) {
      expect(looksLikeSmiles(s), s).toBe(true);
    }
  });

  it('rejects the chemistry prose that looks like it', () => {
    // Every one of these appears in ordinary answers. Drawing a structure for any of them is worse
    // than drawing nothing.
    for (const s of ['pH', 'NMR', 'DMSO', '1H', 'the', '25 °C', 'v/v', '']) {
      expect(looksLikeSmiles(s), s).toBe(false);
    }
  });
});

describe('looksLikeReactionSmiles', () => {
  it('accepts a reaction and rejects a plain molecule', () => {
    expect(looksLikeReactionSmiles('CCO.CC(=O)O>>CCOC(C)=O')).toBe(true);
    expect(looksLikeReactionSmiles('CCO')).toBe(false);
  });

  it('rejects an arrow with nothing molecule-shaped around it', () => {
    // A reaction is not a licence to relax the check that stops arbitrary punctuation being drawn.
    expect(looksLikeReactionSmiles('a>>b')).toBe(false);
    expect(looksLikeReactionSmiles('>>')).toBe(false);
  });
});

describe('looksLikeCompoundName', () => {
  it('tells a compound name apart from a malformed SMILES', () => {
    expect(looksLikeCompoundName('4-bromoanisole')).toBe(true);
    expect(looksLikeCompoundName('acetic acid')).toBe(true);
    // Legal atom letters throughout: this is a bad SMILES, not a name, and deserves the plain
    // message rather than a confident wrong explanation.
    expect(looksLikeCompoundName('CCO')).toBe(false);
    expect(looksLikeCompoundName('COc1ccc(Br)cc1')).toBe(false);
  });
});

describe('smilesFromArguments', () => {
  it('finds molecules under any key, including nested ones', () => {
    const args = JSON.stringify({ reactants: ['CCO', 'CC(=O)O'], opts: { solvent: 'c1ccccc1' } });
    expect(smilesFromArguments(args)).toEqual(['CCO', 'CC(=O)O', 'c1ccccc1']);
  });

  it('refuses a document that does not parse', () => {
    // THE load-bearing test. A truncated arguments string is not JSON, and a SMILES cut out of one
    // can still parse as a valid, smaller, wrong molecule. Refusing the whole document is the only
    // check that cannot be fooled by that.
    expect(smilesFromArguments('{"smiles": "COc1ccc(Br)c')).toEqual([]);
  });

  it('deduplicates', () => {
    expect(smilesFromArguments(JSON.stringify({ a: 'CCO', b: 'CCO' }))).toEqual(['CCO']);
  });
});

describe('rdkit helpers', () => {
  it('collapses two spellings of one molecule to one key', async () => {
    // The entity rail's whole premise, and the thing smiles-drawer could not do:
    // `COc1ccc(Br)cc1` and `BrC1=CC=C(OC)C=C1` are one compound.
    expect(await canonicalSmiles('BrC1=CC=C(OC)C=C1')).toBe('COc1ccc(Br)cc1');
    expect(await canonicalSmiles('OCC')).toBe(await canonicalSmiles('CCO'));
  });

  it('says no to something that is not a molecule', async () => {
    expect(await isMolecule('CCO')).toBe(true);
    expect(await isMolecule('not-a-molecule')).toBe(false);
  });

  it('frees every handle it takes', async () => {
    // Emscripten objects are not garbage-collected; a forgotten one leaks for the page's lifetime,
    // and nothing else in the stack would notice.
    await canonicalSmiles('CCO');
    await isMolecule('CCO');
    await moleculeSvg('COc1ccc(Br)cc1', { width: 100, height: 100 });
    expect(liveHandles()).toBe(0);
  });

  it('frees handles even when parsing fails', async () => {
    await canonicalSmiles('not-a-molecule');
    await moleculeSvg('not-a-molecule', { width: 100, height: 100 });
    expect(liveHandles()).toBe(0);
  });
});

describe('<Molecule>', () => {
  it('draws the canonical structure', async () => {
    const { container } = render(<Molecule smiles="BrC1=CC=C(OC)C=C1" />);
    await waitFor(() =>
      expect(container.querySelector('[data-smiles="COc1ccc(Br)cc1"]')).toBeTruthy(),
    );
  });

  it('shows the string it could not read rather than an empty box', async () => {
    render(<Molecule smiles="not-a-molecule" />);
    // The string is the evidence for why nothing was drawn — swallowing it leaves a chemist with
    // a blank rectangle and no way to tell a bad SMILES from a broken renderer.
    await waitFor(() => expect(screen.getByText('not-a-molecule')).toBeTruthy());
  });
});
