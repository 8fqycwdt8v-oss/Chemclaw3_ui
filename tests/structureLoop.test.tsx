/**
 * The loop: a structure that is drawn can be used, and a structure that was sent stays visible.
 *
 * Every structure this app rendered used to be terminal. The agent would give a chemist the SMILES
 * they asked for, the UI would draw it and RDKit would confirm it — and the only way to ask a
 * follow-up was to select the text with a mouse. And the user's own message was a bare `<p>`, so
 * the drawing the structure panel showed to satisfy "never send a structure you have not seen" was
 * discarded the moment it was sent.
 *
 * These three things are one behaviour and are tested together, because half of it is worth very
 * little: a reusable structure a chemist cannot see in their own transcript is not reusable.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Markdown } from '../src/components/Markdown.tsx';
import { StructureText } from '../src/components/Molecule.tsx';
import { usePrefsStore } from '../src/state/prefsStore.ts';
import { INSERT_STRUCTURE_EVENT } from '../src/state/composerEvents.ts';

/** What the composer would have received. */
function captureInserts(): { seen: string[]; stop: () => void } {
  const seen: string[] = [];
  const listener = (e: Event): void => {
    seen.push((e as CustomEvent<{ smiles: string }>).detail.smiles);
  };
  window.addEventListener(INSERT_STRUCTURE_EVENT, listener);
  return { seen, stop: () => window.removeEventListener(INSERT_STRUCTURE_EVENT, listener) };
}

beforeEach(() => {
  cleanup();
  usePrefsStore.setState({ drawStructures: false });
});

afterEach(() => {
  cleanup();
});

describe('a structure in an answer', () => {
  it('offers a button, and hands the canonical form back when it is used', async () => {
    const inserts = captureInserts();
    try {
      render(<Markdown>{'The bromide is `BrC1=CC=C(OC)C=C1`.'}</Markdown>);

      // The affordance waits for RDKit — a token that merely looks like a SMILES never gets one.
      const show = await screen.findByLabelText('Show structure for BrC1=CC=C(OC)C=C1');
      fireEvent.click(show);

      const use = await screen.findByLabelText('Use COc1ccc(Br)cc1 in my message');
      fireEvent.click(use);

      // The canonical form, not the spelling the answer used. It is the entity key, and handing
      // back the other one would file the same compound twice.
      expect(inserts.seen).toEqual(['COc1ccc(Br)cc1']);
    } finally {
      inserts.stop();
    }
  });

  it('is offered for a reaction, which used to fall through to plain text', async () => {
    // `looksLikeSmiles` rejects anything containing `>`, so the old gate said no to every reaction
    // — including the ones `similar_reactions` exists to return — while `Molecule` could draw them.
    render(<Markdown>{'Precedent: `Brc1ccccc1.OB(O)c1ccccc1>>c1ccc(-c2ccccc2)cc1`'}</Markdown>);

    expect(
      await screen.findByLabelText(
        'Show structure for Brc1ccccc1.OB(O)c1ccccc1>>c1ccc(-c2ccccc2)cc1',
      ),
    ).toBeTruthy();
  });

  it('offers nothing for a token RDKit refuses', async () => {
    render(<Markdown>{'Run it at `CCXQ` for an hour.'}</Markdown>);

    await waitFor(() => expect(screen.queryByText('CCXQ')).toBeTruthy());
    expect(screen.queryByLabelText(/Show structure for/)).toBeNull();
  });
});

describe('the draw-structures preference', () => {
  it('draws without being asked, and removes the per-token button entirely', async () => {
    usePrefsStore.setState({ drawStructures: true });
    render(<Markdown>{'The bromide is `COc1ccc(Br)cc1`.'}</Markdown>);

    // Drawn, unasked.
    await waitFor(() =>
      expect(document.querySelector('[data-smiles="COc1ccc(Br)cc1"]')).toBeTruthy(),
    );
    // And the button is gone rather than pre-pressed: a control with one reachable state is
    // furniture, and the thing that changes it is the toggle in the top bar.
    expect(screen.queryByLabelText(/Show structure for/)).toBeNull();
    expect(screen.queryByLabelText(/Hide structure for/)).toBeNull();
  });

  it('still refuses to draw a string RDKit will not read, whichever way it is set', async () => {
    usePrefsStore.setState({ drawStructures: true });
    render(<Markdown>{'Held at `CCXQ`.'}</Markdown>);

    await waitFor(() => expect(screen.queryByText('CCXQ')).toBeTruthy());
    expect(document.querySelector('[data-smiles]')).toBeNull();
  });
});

describe("the chemist's own message", () => {
  it('keeps the structure they confirmed, instead of showing a bare string', async () => {
    render(<StructureText text="screen COc1ccc(Br)cc1 for hazards" />);

    expect(await screen.findByLabelText('Show structure for COc1ccc(Br)cc1')).toBeTruthy();
    // The words around it are untouched — this is plain text, not markdown.
    expect(document.body.textContent).toContain('screen');
    expect(document.body.textContent).toContain('for hazards');
  });

  it('leaves markdown syntax alone, because a chemist typed it', () => {
    // A parser would read the underscores as emphasis and eat them out of the name.
    render(<StructureText text="use the *fresh* batch of tert_butyl_ether" />);

    expect(document.body.textContent).toContain('*fresh*');
    expect(document.body.textContent).toContain('tert_butyl_ether');
  });

  it('preserves the exact spacing and line breaks', () => {
    render(<StructureText text={'first line\n  indented CCO'} />);

    expect(document.body.textContent).toBe('first line\n  indented CCO');
  });
});
