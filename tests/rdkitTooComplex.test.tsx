/**
 * A molecule RDKit reads and cannot name, and the four surfaces that have to say so differently.
 *
 * **The defect, measured rather than reported** (`ISSUES.md` Issue 11, and
 * `scripts/measure-rdkit-rangeerror.mjs` is what produced the numbers). `MAX_PARSED_SMILES_CHARS`
 * is 600 and its whole job is to keep every refusal above it honest — so a 580-character chain is
 * *inside* the cap by design. Driven in real Chromium through this app's own seam, on a fresh page
 * per length: at 200 to 570 characters `canonicalSmiles` answered, and at 580, 590 and 600 it
 * answered `null` — while the engine called directly on the same page, on the same thread, from a
 * shallower stack, answered at every one of those lengths milliseconds later. RDKit's canonical
 * ranking recurses, the stack runs out, and `withMol` swallowed the `RangeError` into the negative
 * that means "not a molecule".
 *
 * So the string on screen is a molecule, the very next call draws it, and the app said it was not
 * one — depending on the JavaScript stack at the moment of the call rather than on the chemistry.
 *
 * **What this file drives is the whole seam rather than the catch.** The stub
 * (`tests/stubs/rdkit.ts`) models the one property the measurement found: `get_mol` accepts
 * `CANONICALISATION_OVERFLOWS` and only `get_smiles` throws, because only the ranking recurses.
 * happy-dom has no `Worker`, so every case here runs the **page** placement — the one with the
 * biggest stack, where the escalation `rdkit.client.ts` performs has nowhere left to send it and
 * the answer has to be honest instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  FIELD_PLACEHOLDER,
  StructureInput,
  TOO_COMPLEX_EXPLANATION,
} from '../src/components/StructureInput.tsx';
import { Composer } from '../src/components/Composer.tsx';
import {
  canonicalSmiles,
  isMolecule,
  moleculeSvg,
  readCanonicalSmiles,
} from '../src/chem/rdkit.ts';
import { readStructure } from '../src/chem/structure.ts';
import { entitiesOf, useEntityStore } from '../src/chem/entities.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import { CANONICALISATION_OVERFLOWS, liveHandles, resetHandles } from './stubs/rdkit.ts';
import { pasteInto } from './helpers.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
}));

vi.mock('../src/api/client.ts', () => ({
  api: { listProfiles: async () => [], uploadAttachment: vi.fn() },
}));

/** The measurement's subject: inside the cap, a molecule, and unnameable on this thread. */
const LONG = CANONICALISATION_OVERFLOWS;

const field = (): HTMLInputElement =>
  screen.getByPlaceholderText(FIELD_PLACEHOLDER) as HTMLInputElement;

/** The sentence that must never be said about this string. */
const CHEMICAL_VERDICT = /could not read this as a molecule/i;
/**
 * The sentence that says whose limit it is — the **whole** shared claim, not a fragment of it.
 *
 * This used to be `/too complex to name here/i`, 25 characters of a 200-character sentence, while
 * `Composer.tsx`'s comment beside its copy said one string must not get two different sentences
 * from the two surfaces that check pastes. Measured: they diverged in *both* tails, and this
 * matched anyway. A guard satisfied by the prose describing it is not a guard, so the invariant is
 * now the constant both surfaces read, asserted whole and asserted to be one object rather than
 * two strings that happen to agree today.
 */
const RENDERER_LIMIT = TOO_COMPLEX_EXPLANATION;

beforeEach(() => {
  cleanup();
  resetHandles();
  useEntityStore.getState().clear();
  useChatStore.setState({ composerLock: false, streaming: null, drafts: {}, banner: null });
});

afterEach(cleanup);

describe('the seam', () => {
  it('answers three different things about one string, and they are not the same fact', async () => {
    // The cap is not what refuses this: it is inside it, which is what makes the negative a claim.
    expect(LONG.length).toBeLessThanOrEqual(600);

    expect(await readCanonicalSmiles(LONG)).toEqual({ status: 'too-complex' });
    // Measured, and the reason `isMolecule` and `moleculeSvg` are left alone: the recursion is in
    // the canonical ranking, so neither of these reaches it. Their columns in
    // `scripts/measure-rdkit-rangeerror.mjs` answer at every length it sweeps, including the ones
    // where `canonicalSmiles` does not — so this pair is the stub standing in for that, not a
    // second opinion about it.
    expect(await isMolecule(LONG)).toBe(true);
    expect(await moleculeSvg(LONG, { width: 300, height: 200 })).not.toBeNull();
  });

  it('still answers `null` for a key, because there is no key to answer with', async () => {
    // The invariant that must survive the fix, not a leftover of it. Every consumer of
    // `canonicalSmiles` drops the molecule on a falsy answer, and what would be wrong is not the
    // missing row — it is the raw spelling becoming a key nothing else can ever match.
    expect(await canonicalSmiles(LONG)).toBeNull();
  });

  it('frees the handle it could not name', async () => {
    // The `RangeError` leaves the catch through a different branch now. A `JSMol` is an Emscripten
    // pointer, so a branch that skipped the `finally` would leak for the life of the thread.
    await readCanonicalSmiles(LONG);
    expect(liveHandles()).toBe(0);
  });
});

describe('`readStructure`', () => {
  it('reports the third kind rather than "not a structure"', async () => {
    expect(await readStructure(LONG)).toEqual({ kind: 'too-complex', raw: LONG });
  });
});

describe('the structure panel', () => {
  it('says whose limit it is, rather than calling a molecule unreadable', async () => {
    render(<StructureInput onAccept={vi.fn()} onClose={vi.fn()} />);

    fireEvent.change(field(), { target: { value: LONG } });

    // `exact: false`, because each surface appends the one clause that is genuinely its own —
    // this panel has nothing to file the molecule under. What must be identical is the sentence.
    expect(await screen.findByText(RENDERER_LIMIT, { exact: false })).toBeTruthy();
    expect(screen.queryByText(CHEMICAL_VERDICT)).toBeNull();
    // And nothing is insertable: there is no canonical form to insert, and the panel's whole
    // contract is that a chemist sends a structure this app has read back to them.
    expect(screen.queryByText('Insert')).toBeNull();
  });
});

describe('the number this file is about', () => {
  it('is the one the measurement produced, in the stub and in the prose', () => {
    // **Two declarations of one fact, and only one of them was a thing a test could see.** The
    // sweep (`scripts/measure-rdkit-rangeerror.mjs`) answered up to 570 and refused at 580; the
    // engine's `Refused` docstring, its `withMol` comment and this file's own header all cite 580;
    // the stub drove 500. A reader checking the prose against the tests found them disagreeing
    // about the subject, which is the state this assertion exists to end.
    expect(LONG.length).toBe(580);
    expect(
      readFileSync('src/chem/rdkit.engine.ts', 'utf8').includes('chain of 580 characters'),
      'the engine no longer cites the length this suite drives, so the two have drifted again',
    ).toBe(true);
  });
});

describe('the two surfaces', () => {
  it('reach one sentence rather than two that agree today', () => {
    // **The invariant the fragment match could not see.** Both surfaces render
    // `TOO_COMPLEX_EXPLANATION` — the same object, not two string literals — so a reword is one
    // edit and cannot land on one surface only. Driven against the source rather than the DOM,
    // because that is where the duplication was: the tails that diverged were in the JSX.
    const surfaces = ['src/components/StructureInput.tsx', 'src/components/Composer.tsx'] as const;
    for (const file of surfaces) {
      const text = readFileSync(file, 'utf8');
      expect(
        text.includes('{TOO_COMPLEX_EXPLANATION}'),
        `${file} does not render the shared sentence, so the two surfaces can drift again`,
      ).toBe(true);
      // And neither *renders* a copy beside it. The head was identical when the two diverged, so
      // a second copy would satisfy every assertion above while the tails said different things.
      // Comments are stripped first: a docstring describing the sentence is not a second edition
      // of it, and both files legitimately carry one.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const copies = code.split('ran out of stack naming it').length - 1;
      expect(copies, `${file} renders the sentence as a literal instead of reading it`).toBe(
        file.endsWith('StructureInput.tsx') ? 1 : 0,
      );
    }
  });
});

describe('the composer', () => {
  it('says the same thing about a paste, in the same words', async () => {
    render(<Composer conversationId="c-too-complex" />);

    pasteInto(screen.getByLabelText('Message') as HTMLTextAreaElement, LONG, 0);

    const strip = await screen.findByRole('alert');
    // `toContain` on the whole shared sentence, which is what "the same words" means. A regex over
    // a fragment of it passed while the two tails said different things.
    expect(strip.textContent).toContain(RENDERER_LIMIT);
    // The two surfaces must not reach two different sentences about one string.
    expect(strip.textContent).not.toMatch(CHEMICAL_VERDICT);
  });

  it('mints no entity from a spelling nothing canonicalised', async () => {
    render(<Composer conversationId="c-too-complex" />);
    pasteInto(screen.getByLabelText('Message') as HTMLTextAreaElement, LONG, 0);
    await screen.findByRole('alert');

    // The bound `tests/rdkitUnavailable.test.tsx` holds for the absent toolkit, held here for the
    // case the toolkit is present and still has no name. A rail that fell back to the raw string
    // would file one compound under a key nothing else can match, and a later success — a shorter
    // spelling, a bigger stack — would not merge with it.
    await waitFor(() => {
      expect(entitiesOf(useEntityStore.getState(), 'c-too-complex').order).toEqual([]);
    });
    expect(
      await useEntityStore.getState().ingestUserStructure('c-too-complex', LONG, 'paste'),
    ).toBeNull();
  });
});
