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
import {
  FIELD_PLACEHOLDER,
  SKETCHER_ALTERNATIVE,
  StructureInput,
} from '../src/components/StructureInput.tsx';
import { Composer } from '../src/components/Composer.tsx';
import { MAX_SDF_RECORDS, moleculesFromMolfile, splitSdfRecords } from '../src/chem/rdkit.ts';
import { entitiesOf, useEntityStore } from '../src/chem/entities.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import { liveHandles, resetHandles } from './stubs/rdkit.ts';
import {
  destroyCount,
  mountedWith,
  resetSketcherStub,
  setDrawing,
  setMountFailure,
} from './stubs/sketcher.tsx';
import { molblock } from './helpers.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
}));

const ETHANOL = molblock(['C', 'C', 'O']);
/** The same file as any exporter actually writes it: line 1 empty. `MolToMolBlock`, ChemDraw and
 *  most exporters leave the title blank, and it is the case every fixture here used to get wrong. */
const UNTITLED_ETHANOL = molblock(['C', 'C', 'O'], '');
const BROMOANISOLE = molblock([...Array<string>(7).fill('C'), 'Br', 'O']);
/** The counts line promises three atoms and two are present — what a half-written file looks like. */
const TRUNCATED = ETHANOL.split('\n').slice(0, -2).join('\n');

const sdf = (records: string[]): string => records.map((r) => `${r}\n$$$$`).join('\n');

const molfile = (name: string, text: string): File =>
  new File([text], name, { type: 'chemical/x-mdl-molfile' });

/**
 * A file whose `text()` does not resolve until it is released.
 *
 * A real `.sdf` read is a file-system round trip plus a full RDKit pass over every record, which
 * is where the race lives: nothing about the read is instantaneous and nothing cancelled it.
 * `release` waits out the macrotasks the read needs afterwards, so the assertion that follows it
 * is about a finished read rather than about a lucky order.
 */
function gatedMolfile(name: string, text: string): { file: File; release: () => Promise<void> } {
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const file = molfile(name, text);
  Object.defineProperty(file, 'text', {
    value: async () => {
      await gate;
      return text;
    },
  });
  return {
    file,
    release: async () => {
      open();
      for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

beforeEach(() => {
  cleanup();
  resetHandles();
  resetSketcherStub();
  useEntityStore.getState().clear();
  useChatStore.setState({ composerLock: false, streaming: null, drafts: {} });
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

  it('stops at the record cap and says how many it did not read', async () => {
    // ~0.9 ms of blocking WASM per record after warm-up, so an uncapped read of a 50k screening
    // set is ~45 s of a tab that cannot paint. What is past the cap is counted, not dropped in
    // silence: "1000 structures" and "1000 of 1002" are different facts about a file.
    const many = sdf(Array<string>(MAX_SDF_RECORDS + 2).fill(ETHANOL));
    const { smiles, skipped, unreadable } = await moleculesFromMolfile(many);

    expect(smiles).toHaveLength(MAX_SDF_RECORDS);
    expect(skipped).toBe(2);
    expect(unreadable).toBe(0);
  });

  it('frees every handle, including for the records it refused', async () => {
    await moleculesFromMolfile(sdf([ETHANOL, TRUNCATED, BROMOANISOLE]));
    expect(liveHandles()).toBe(0);
  });
});

describe('<StructureInput>', () => {
  const field = (): HTMLInputElement =>
    screen.getByPlaceholderText(FIELD_PLACEHOLDER) as HTMLInputElement;

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
      moreRecords: false,
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
    // nothing validated is the failure this codebase is built to avoid. Asserted on the drawing
    // rather than on `svg`, because the panel's own icon buttons are SVGs too.
    expect(container.querySelector('[data-smiles]')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText('Insert')).toBeNull();
  });

  it('says that a name is not a structure, and points at the thing that can resolve it', async () => {
    render(<StructureInput onAccept={vi.fn()} onClose={vi.fn()} />);

    fireEvent.change(field(), { target: { value: '4-bromoanisole' } });

    // `resolve_compound` exists but is an agent tool with no HTTP route, so the panel still cannot
    // look a name up — it hands the question to the thing that can.
    const message = await screen.findByText(/a name is not a structure/i);
    expect(message.textContent).toContain('the agent does');
    expect(screen.queryByText('Insert')).toBeNull();
    expect(screen.getByText('Ask the agent for the SMILES')).toBeTruthy();
  });

  it('asks the agent to resolve a name, rather than telling the chemist to retype the question', async () => {
    const onClose = vi.fn();
    const prefilled: unknown[] = [];
    const listener = (e: Event): void => {
      prefilled.push((e as CustomEvent).detail);
    };
    window.addEventListener('chemclaw:prefill', listener);

    try {
      render(<StructureInput onAccept={vi.fn()} onClose={onClose} />);
      fireEvent.change(field(), { target: { value: '4-bromoanisole' } });
      await screen.findByText('Ask the agent for the SMILES');
      fireEvent.click(screen.getByText('Ask the agent for the SMILES'));

      // A plain string, not the autoSend shape: the chemist should see the question before it
      // goes, because they may want to add "…and screen it for hazards" to the same turn.
      expect(prefilled).toEqual(['Give me the canonical SMILES for 4-bromoanisole.']);
      // And the panel gets out of the way — the composer now holds the question.
      expect(onClose).toHaveBeenCalled();
    } finally {
      window.removeEventListener('chemclaw:prefill', listener);
    }
  });

  it('reads a dropped MOL file through RDKit and shows what it understood', async () => {
    const onAccept = vi.fn();
    const { container } = render(<StructureInput onAccept={onAccept} onClose={vi.fn()} />);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [molfile('ethanol.mol', ETHANOL)] } });

    await waitFor(() => expect(field().value).toBe('CCO'));
    await waitFor(() => expect(container.querySelector('[data-smiles="CCO"]')).toBeTruthy());
    fireEvent.click(screen.getByText('Insert'));

    expect(onAccept).toHaveBeenCalledWith({
      canonical: 'CCO',
      raw: 'CCO',
      source: 'file',
      moreRecords: false,
    });
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
      // The panel must stay open for a record set, so the composer is told there are more. Every
      // record after the first used to cost a full reopen.
      moreRecords: true,
    });
    // And it says which records are already taken, because record 2 looks identical before and
    // after it was inserted.
    expect(screen.getByText(/1 inserted/)).toBeTruthy();
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

  it('tells a screen reader the canvas has a text alternative, on open', async () => {
    // The canvas is a third-party WASM editor and nothing here can make it navigable; what this
    // application owes a keyboard or screen-reader user is therefore not a navigable canvas but
    // the fact that two other doors reach the same place. Radix announces `Dialog.Description` as
    // the dialog's accessible description when it opens, so this is the assertion that the
    // alternative is *told* rather than merely existing behind the modal.
    render(<StructureInput onAccept={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Draw'));

    const dialog = await screen.findByRole('dialog');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy, 'the sketcher dialog has no accessible description').toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe(SKETCHER_ALTERNATIVE);

    // And the alternative it names is genuinely there behind the dialog: the same labelled field
    // every other door writes into.
    expect(screen.getByLabelText('SMILES')).toBeTruthy();
  });

  it('closes the sketcher on Escape without being clicked into first', async () => {
    render(<StructureInput onAccept={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Draw'));
    await waitFor(() => expect(document.querySelector('[data-sketcher="mounted"]')).toBeTruthy());

    // The hand-rolled version put this handler on the overlay div, which never receives focus — so
    // Escape did nothing until the user had clicked inside, which is the one moment they have not
    // yet done. The Radix dialog owns the key now, and this asserts that it really does.
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
    render(<StructureInput onAccept={onAccept} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Draw'));
    // The seam is real: this only appears once `loadSketcher()` has resolved an adapter and mounted
    // it into the host element the dialog provides.
    await waitFor(() => expect(document.querySelector('[data-sketcher="mounted"]')).toBeTruthy());

    // A molblock, not a SMILES — the seam's contract, and the reason RDKit still gets the last word.
    setDrawing(ETHANOL);
    fireEvent.click(screen.getByText('Use this structure'));

    await waitFor(() => expect(field().value).toBe('CCO'));
    await waitFor(() => expect(document.querySelector('[data-smiles="CCO"]')).toBeTruthy());

    fireEvent.click(screen.getByText('Insert'));
    expect(onAccept).toHaveBeenCalledWith({
      canonical: 'CCO',
      raw: 'CCO',
      source: 'sketch',
      moreRecords: false,
    });
    // The editor was torn down when the dialog closed; a live one behind a closed dialog is a leak
    // of a worker and a WASM heap, not just a stray node.
    expect(destroyCount()).toBe(1);
  });

  it('says nothing is drawn rather than inserting an empty structure', async () => {
    render(<StructureInput onAccept={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Draw'));
    await waitFor(() => expect(document.querySelector('[data-sketcher="mounted"]')).toBeTruthy());

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

  it('lets what the chemist typed win over a file read that is still in flight', async () => {
    const { container } = render(<StructureInput onAccept={vi.fn()} onClose={vi.fn()} />);
    const gated = gatedMolfile('screening.sdf', sdf([ETHANOL]));

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [gated.file] } });
    await screen.findByText(/Reading screening\.sdf/);

    // Bored waiting, so they type their own structure. The field is the confirmation surface: a
    // write into it from a source the chemist has moved on from replaces the structure under
    // review, and Insert would then insert the file's first record.
    fireEvent.change(field(), { target: { value: 'CC(=O)O' } });
    await gated.release();

    expect(field().value).toBe('CC(=O)O');
    expect(screen.queryByText(/screening\.sdf: 1 structure/)).toBeNull();
  });

  it('refuses a file too big to read on the main thread, and names the limit', async () => {
    const { container } = render(<StructureInput onAccept={vi.fn()} onClose={vi.fn()} />);

    const huge = molfile('screen.sdf', ETHANOL);
    const read = vi.fn(async () => ETHANOL);
    Object.defineProperty(huge, 'size', { value: 40 * 1024 * 1024 });
    Object.defineProperty(huge, 'text', { value: read });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [huge] } });

    // Named, because "too big" without the number is a dead end: the whole file used to be
    // materialised as a string and parsed record by record in WASM on the main thread, with
    // "Reading …" as the only feedback and no way to cancel.
    expect(await screen.findByText(/40 MB.*8 MB/)).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses a dropped file it could never read, instead of parsing a video as text', async () => {
    const { container } = render(<StructureInput onAccept={vi.fn()} onClose={vi.fn()} />);

    const video = new File(['not text at all'], 'clip.mp4', { type: 'video/mp4' });
    const read = vi.fn(async () => '');
    Object.defineProperty(video, 'text', { value: read });
    // The panel takes anything dropped on it — the `accept=` on the picker only filters the
    // picker — so this door was the one with no extension check behind it.
    fireEvent.drop(container.firstElementChild as HTMLElement, {
      dataTransfer: { files: [video], types: ['Files'] },
    });

    expect(await screen.findByText(/\.mol, \.sdf or \.mdl/)).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
  });

  it('reads a molblock pasted into the field, which the field itself cannot hold', async () => {
    render(<StructureInput onAccept={vi.fn()} onClose={vi.fn()} />);

    // What ChemDraw puts on the clipboard. This is an `<input type="text">`: a browser strips the
    // newlines on paste and leaves one unparseable line of MDL, so the paste has to be taken over
    // rather than allowed through.
    fireEvent.paste(field(), {
      clipboardData: { getData: () => molblock(['C', 'C', 'O'], '') },
    });

    await waitFor(() => expect(field().value).toBe('CCO'));
    expect(await screen.findByText(/Read the pasted molfile/)).toBeTruthy();
  });

  it('opens the sketcher on the structure already in the field', async () => {
    render(<StructureInput onAccept={vi.fn()} onClose={vi.fn()} />);

    fireEvent.change(field(), { target: { value: 'BrC1=CC=C(OC)C=C1' } });
    await waitFor(() => expect(screen.queryByText('Insert')).toBeTruthy());

    fireEvent.click(screen.getByText('Draw'));
    await waitFor(() => expect(document.querySelector('[data-sketcher="mounted"]')).toBeTruthy());

    // Correcting one bond in a thirty-atom molecule used to mean redrawing it from scratch, which
    // is two independent chances to get it wrong. The canonical form, because that is the
    // structure the panel confirmed.
    expect(mountedWith()).toBe('COc1ccc(Br)cc1');
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

    fireEvent.click(screen.getByLabelText('Insert a structure'));
    fireEvent.change(screen.getByPlaceholderText(FIELD_PLACEHOLDER), {
      target: { value: 'BrC1=CC=C(OC)C=C1' },
    });
    await waitFor(() => expect(screen.queryByText('Insert')).toBeTruthy());
    fireEvent.click(screen.getByText('Insert'));

    // At the caret, spaced, and still sitting in the box: a structure is almost never the whole
    // question, so sending it on its own would make the chemist describe the molecule twice.
    await waitFor(() => expect(textarea.value).toBe('screen COc1ccc(Br)cc1 for hazards'));
  });

  it('promotes an accepted structure into the entity rail under its canonical key', async () => {
    render(<Composer conversationId="c1" />);

    fireEvent.click(screen.getByLabelText('Insert a structure'));
    fireEvent.change(screen.getByPlaceholderText(FIELD_PLACEHOLDER), {
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
