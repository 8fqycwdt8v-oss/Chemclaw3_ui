/**
 * Getting a structure into a message.
 *
 * The thing under test is not "does the panel work" but a single rule applied to three doors: a
 * structure reaches the message only after RDKit has read it and the chemist has seen it drawn.
 * Paste, drop and draw all converge on that, so each door is checked for the same two properties —
 * what comes out is *canonical*, and nothing is drawn or insertable when RDKit says no.
 *
 * The sketcher is exercised through its real seam (`src/chem/sketcher.ts`); only the Ketcher
 * adapter is faked, in `tests/stubs/sketcher.tsx`. The stub returns a molblock rather than SMILES
 * on purpose: if the production path ever stopped canonicalising the drawing through RDKit, these
 * tests would fail rather than quietly accept a second toolkit's opinion.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StructureInput } from '../src/components/StructureInput.tsx';
import { Composer } from '../src/components/Composer.tsx';
import { moleculesFromMolfile, splitSdfRecords } from '../src/chem/rdkit.ts';
import { looksLikeCompoundName } from '../src/chem/recognise.ts';
import { entitiesOf, useEntityStore } from '../src/chem/entities.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import { liveHandles, resetHandles } from './stubs/rdkit.ts';
import { destroyCount, resetSketcherStub, setDrawing, setMountFailure } from './stubs/sketcher.tsx';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => 'token' } }),
}));

/**
 * An MDL V2000 molblock with the given atoms.
 *
 * Written out at the real column offsets rather than approximated, because the element symbol
 * lives at columns 32–34 and a fixture that got that wrong would be testing the fixture. Bonds are
 * omitted — the RDKit fake keys on atom composition and says so.
 *
 * `title` defaults to a non-empty string only because most fixtures read better that way. The
 * **blank** title is the normal case in the wild — `MolToMolBlock`, ChemDraw and most exporters
 * leave line 1 empty — and it is the one every fixture here used to get wrong, which is why
 * `UNTITLED_ETHANOL` below exists.
 */
function molblock(symbols: string[], title = 'stub'): string {
  const zero = (0).toFixed(4).padStart(10, ' ');
  const counts = `${String(symbols.length).padStart(3, ' ')}  0  0  0  0  0  0  0  0999 V2000`;
  const atoms = symbols.map(
    (symbol) => `${zero}${zero}${zero} ${symbol.padEnd(3, ' ')} 0  0  0  0  0  0  0  0  0  0  0  0`,
  );
  return [title, '  stub-suite', '', counts, ...atoms, 'M  END'].join('\n');
}

const ETHANOL = molblock(['C', 'C', 'O']);
/** The same file as any exporter actually writes it: line 1 empty. */
const UNTITLED_ETHANOL = molblock(['C', 'C', 'O'], '');
const BROMOANISOLE = molblock([...Array<string>(7).fill('C'), 'Br', 'O']);
/** The counts line promises three atoms and two are present — what a half-written file looks like. */
const TRUNCATED = ETHANOL.split('\n').slice(0, -2).join('\n');

const sdf = (records: string[]): string => records.map((r) => `${r}\n$$$$`).join('\n');

const molfile = (name: string, text: string): File =>
  new File([text], name, { type: 'chemical/x-mdl-molfile' });

beforeEach(() => {
  cleanup();
  resetHandles();
  resetSketcherStub();
  useEntityStore.getState().clear();
  useChatStore.setState({ composerLock: false, streaming: null });
});

afterEach(cleanup);

describe('molfile reading', () => {
  it('splits an SDF on its record terminator and leaves a plain MOL file whole', () => {
    expect(splitSdfRecords(sdf([ETHANOL, BROMOANISOLE]))).toHaveLength(2);
    expect(splitSdfRecords(ETHANOL)).toHaveLength(1);
  });

  it('keeps a record’s blank title line, wherever in the file it sits', () => {
    // The header is four *fixed* lines and the first of them is routinely empty, so the leading
    // newline is data. Trimming it shifted the counts line up by one and turned a valid file into
    // "No structure found in <file>" — silently, because a shifted header still parses as
    // *something*. Checked at both positions: the first record has no delimiter in front of it,
    // the second is preceded by one whose own newline must be eaten and no more.
    const [first, second] = splitSdfRecords(sdf([UNTITLED_ETHANOL, UNTITLED_ETHANOL]));
    for (const record of [first, second]) {
      expect(record?.split('\n')[0]).toBe('');
      expect(record?.split('\n')[3]).toMatch(/V2000$/);
    }
  });

  it('reads a molfile whose title line is empty', async () => {
    // The end-to-end version of the case above, through RDKit rather than through the splitter.
    const { smiles, unreadable } = await moleculesFromMolfile(UNTITLED_ETHANOL);
    expect(smiles).toEqual(['CCO']);
    expect(unreadable).toBe(0);
    expect((await moleculesFromMolfile(sdf([UNTITLED_ETHANOL, BROMOANISOLE]))).smiles).toEqual([
      'CCO',
      'COc1ccc(Br)cc1',
    ]);
  });

  it('reads every record of a multi-record file, not just the first', async () => {
    // The rejected alternative, written down: taking record 1 and discarding the rest would pass a
    // test that only looked at the first structure.
    const { smiles, unreadable } = await moleculesFromMolfile(sdf([ETHANOL, BROMOANISOLE]));
    expect(smiles).toEqual(['CCO', 'COc1ccc(Br)cc1']);
    expect(unreadable).toBe(0);
  });

  it('counts a record it cannot read instead of silently dropping it', async () => {
    const { smiles, unreadable } = await moleculesFromMolfile(sdf([ETHANOL, TRUNCATED]));
    expect(smiles).toEqual(['CCO']);
    expect(unreadable).toBe(1);
  });

  it('frees every handle, including for the records it refused', async () => {
    await moleculesFromMolfile(sdf([ETHANOL, TRUNCATED, BROMOANISOLE]));
    expect(liveHandles()).toBe(0);
  });
});

describe('a name is not a structure', () => {
  it('tells a compound name apart from a malformed SMILES', () => {
    expect(looksLikeCompoundName('4-bromoanisole')).toBe(true);
    expect(looksLikeCompoundName('acetic acid')).toBe(true);
    // Legal atom letters throughout: this is a bad SMILES, not a name, and deserves the plain
    // message rather than a confident wrong explanation.
    expect(looksLikeCompoundName('CCO')).toBe(false);
    expect(looksLikeCompoundName('COc1ccc(Br)cc1')).toBe(false);
  });
});

describe('<StructureInput>', () => {
  const field = (): HTMLInputElement =>
    screen.getByPlaceholderText('Paste SMILES, drop a .mol or .sdf, or draw it') as HTMLInputElement;

  it('accepts a valid SMILES and hands back the canonical form', async () => {
    const onAccept = vi.fn();
    const { container } = render(<StructureInput onAccept={onAccept} onClose={vi.fn()} />);

    fireEvent.change(field(), { target: { value: 'BrC1=CC=C(OC)C=C1' } });

    // Drawn before it can be inserted — the confirmation is the whole affordance.
    await waitFor(() =>
      expect(container.querySelector('[data-smiles="COc1ccc(Br)cc1"]')).toBeTruthy(),
    );
    fireEvent.click(screen.getByText('Insert'));

    expect(onAccept).toHaveBeenCalledWith({
      canonical: 'COc1ccc(Br)cc1',
      raw: 'BrC1=CC=C(OC)C=C1',
      source: 'paste',
    });
  });

  it('refuses a string RDKit cannot read, and draws nothing at all', async () => {
    const onAccept = vi.fn();
    const { container } = render(<StructureInput onAccept={onAccept} onClose={vi.fn()} />);

    // SMILES-shaped enough that the recogniser proposes it, and refused by RDKit — which is the
    // division of labour the whole chemistry layer is built on.
    fireEvent.change(field(), { target: { value: 'C1CC((' } });

    await screen.findByText('RDKit could not read this as a molecule.');
    // Not "shows an error beside a picture": there must be no picture. A structure on screen that
    // nothing validated is the failure this codebase is built to avoid.
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.queryByText('Insert')).toBeNull();
  });

  it('says that a name is not a structure, and points at the thing that can resolve it', async () => {
    render(<StructureInput onAccept={vi.fn()} onClose={vi.fn()} />);

    fireEvent.change(field(), { target: { value: '4-bromoanisole' } });

    // `resolve_compound` exists but is an agent tool with no HTTP route, so the honest answer is a
    // sentence, not a lookup.
    const message = await screen.findByText(/a name is not a structure/i);
    expect(message.textContent).toContain('ask the agent to resolve it');
    expect(screen.queryByText('Insert')).toBeNull();
  });

  it('reads a dropped MOL file through RDKit and shows what it understood', async () => {
    const onAccept = vi.fn();
    const { container } = render(<StructureInput onAccept={onAccept} onClose={vi.fn()} />);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [molfile('ethanol.mol', ETHANOL)] } });

    await waitFor(() => expect(field().value).toBe('CCO'));
    await waitFor(() => expect(container.querySelector('[data-smiles="CCO"]')).toBeTruthy());
    fireEvent.click(screen.getByText('Insert'));

    expect(onAccept).toHaveBeenCalledWith({ canonical: 'CCO', raw: 'CCO', source: 'file' });
  });

  it('shows every structure in a multi-record SDF and inserts one at a time', async () => {
    const onAccept = vi.fn();
    const { container } = render(<StructureInput onAccept={onAccept} onClose={vi.fn()} />);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [molfile('screen.sdf', sdf([ETHANOL, BROMOANISOLE]))] },
    });

    await waitFor(() => expect(field().value).toBe('CCO'));
    expect(screen.getByText('1 / 2')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Next structure in this file'));
    await waitFor(() => expect(field().value).toBe('COc1ccc(Br)cc1'));
    // The stepper must survive the re-validation its own click triggers.
    expect(screen.getByText('2 / 2')).toBeTruthy();

    await waitFor(() =>
      expect(container.querySelector('[data-smiles="COc1ccc(Br)cc1"]')).toBeTruthy(),
    );
    fireEvent.click(screen.getByText('Insert'));
    expect(onAccept).toHaveBeenCalledWith({
      canonical: 'COc1ccc(Br)cc1',
      raw: 'COc1ccc(Br)cc1',
      source: 'file',
    });
  });

  it('starts the stepper over when a second file is loaded', async () => {
    const { container } = render(<StructureInput onAccept={vi.fn()} onClose={vi.fn()} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, {
      target: { files: [molfile('big.sdf', sdf([ETHANOL, BROMOANISOLE, ETHANOL]))] },
    });
    await waitFor(() => expect(screen.getByText('1 / 3')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Next structure in this file'));
    fireEvent.click(screen.getByLabelText('Next structure in this file'));
    expect(screen.getByText('3 / 3')).toBeTruthy();

    // A new file is a new stepper. Without a key it kept its index and read "3 / 2" over the first
    // structure of the file it had just been handed.
    fireEvent.change(input, {
      target: { files: [molfile('small.sdf', sdf([ETHANOL, BROMOANISOLE]))] },
    });
    await waitFor(() => expect(screen.getByText('1 / 2')).toBeTruthy());
    expect(field().value).toBe('CCO');
  });

  it('closes the sketcher on Escape without being clicked into first', async () => {
    const { container } = render(<StructureInput onAccept={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Draw'));
    await waitFor(() => expect(container.querySelector('[data-sketcher="mounted"]')).toBeTruthy());

    // The handler used to sit on the overlay div, which never receives focus — so Escape did
    // nothing until the user had clicked inside, which is the one moment they have not yet done.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Use this structure')).toBeNull());
    // And the editor went with it: a live one behind a closed dialog leaks a worker and a WASM heap.
    expect(destroyCount()).toBe(1);
  });

  it('reports a file with nothing readable in it rather than accepting an empty result', async () => {
    const { container } = render(<StructureInput onAccept={vi.fn()} onClose={vi.fn()} />);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [molfile('broken.mol', TRUNCATED)] } });

    expect(await screen.findByText(/none of which RDKit could read/)).toBeTruthy();
    expect(screen.queryByText('Insert')).toBeNull();
  });

  it('canonicalises what the sketcher drew instead of trusting it', async () => {
    const onAccept = vi.fn();
    const { container } = render(<StructureInput onAccept={onAccept} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Draw'));
    // The seam is real: this only appears once `loadSketcher()` has resolved an adapter and mounted
    // it into the host element the dialog provides.
    await waitFor(() => expect(container.querySelector('[data-sketcher="mounted"]')).toBeTruthy());

    // A molblock, not a SMILES — the seam's contract, and the reason RDKit still gets the last word.
    setDrawing(ETHANOL);
    fireEvent.click(screen.getByText('Use this structure'));

    await waitFor(() => expect(field().value).toBe('CCO'));
    await waitFor(() => expect(container.querySelector('[data-smiles="CCO"]')).toBeTruthy());

    fireEvent.click(screen.getByText('Insert'));
    expect(onAccept).toHaveBeenCalledWith({ canonical: 'CCO', raw: 'CCO', source: 'sketch' });
    // The editor was torn down when the dialog closed; a live one behind a closed dialog is a leak
    // of a worker and a WASM heap, not just a stray node.
    expect(destroyCount()).toBe(1);
  });

  it('says nothing is drawn rather than inserting an empty structure', async () => {
    const { container } = render(<StructureInput onAccept={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Draw'));
    await waitFor(() => expect(container.querySelector('[data-sketcher="mounted"]')).toBeTruthy());

    fireEvent.click(screen.getByText('Use this structure'));
    expect(await screen.findByText('Nothing is drawn yet.')).toBeTruthy();

    // An untouched canvas exports as a *valid* molblock with zero atoms, which is a different
    // shape of nothing and reaches RDKit rather than the branch above. Both have to end in "no
    // structure"; neither may end in an empty SMILES going into a message.
    setDrawing(molblock([]));
    fireEvent.click(screen.getByText('Use this structure'));
    expect(await screen.findByText(/Nothing on the canvas/)).toBeTruthy();
    expect(screen.queryByText('Insert')).toBeNull();
  });

  it('falls back to the paste and drop paths when the editor will not load', async () => {
    setMountFailure(true);
    render(<StructureInput onAccept={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Draw'));

    expect(await screen.findByText(/could not be loaded/)).toBeTruthy();
  });
});

describe('the composer', () => {
  it('inserts the structure at the caret and does not send it', async () => {
    const { container } = render(<Composer conversationId="c1" />);

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'screen  for hazards' } });
    textarea.setSelectionRange(7, 7);

    fireEvent.click(screen.getByTitle(/Insert a structure/));
    fireEvent.change(screen.getByPlaceholderText('Paste SMILES, drop a .mol or .sdf, or draw it'), {
      target: { value: 'BrC1=CC=C(OC)C=C1' },
    });
    await waitFor(() => expect(screen.queryByText('Insert')).toBeTruthy());
    fireEvent.click(screen.getByText('Insert'));

    // At the caret, spaced, and still sitting in the box: a structure is almost never the whole
    // question, so sending it on its own would make the chemist describe the molecule twice.
    await waitFor(() =>
      expect(textarea.value).toBe('screen COc1ccc(Br)cc1 for hazards'),
    );
  });

  it('promotes an accepted structure into the entity rail under its canonical key', async () => {
    render(<Composer conversationId="c1" />);

    fireEvent.click(screen.getByTitle(/Insert a structure/));
    fireEvent.change(screen.getByPlaceholderText('Paste SMILES, drop a .mol or .sdf, or draw it'), {
      target: { value: 'BrC1=CC=C(OC)C=C1' },
    });
    await waitFor(() => expect(screen.queryByText('Insert')).toBeTruthy());
    fireEvent.click(screen.getByText('Insert'));

    await waitFor(() => {
      const entity = entitiesOf(useEntityStore.getState(), 'c1').entities['COc1ccc(Br)cc1'];
      expect(entity?.kind).toBe('molecule');
      // The chemist's own spelling is kept beside the canonical one: they should be able to
      // recognise what they typed in a rail that shows them something else.
      expect(entity?.kind === 'molecule' && entity.aliases).toContain('BrC1=CC=C(OC)C=C1');
      // Provenance says how it got here, and it is not a tool name.
      expect(entity?.mentions[0]?.source).toBe('paste');
      expect(entity?.mentions[0]?.tool).toBeUndefined();
    });
  });
});
