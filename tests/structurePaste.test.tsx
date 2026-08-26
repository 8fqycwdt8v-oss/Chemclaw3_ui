/**
 * The paste confirmation, as a rewrite rather than as a picture.
 *
 * `composerStructures.test.tsx` covers what the strip *shows*. This file covers what its one
 * button *does*, and the states it used to have no way of reaching, because both were silent in
 * the same direction: the strip either wrote a molecule nobody confirmed into the message, or it
 * said nothing at all about a paste the app already knew was wrong.
 *
 * The rule underneath all of it: a confirmation names a span of text. Not a string — a span. Two
 * spellings of one molecule collide constantly (every SMILES is an infix of larger ones), so a
 * confirmation that only knows its own text cannot say which occurrence it is about, and one that
 * outlives an edit to that span is describing a molecule the message no longer contains.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Composer } from '../src/components/Composer.tsx';
import { useChatStore } from '../src/state/chatStore.ts';
import { useEntityStore } from '../src/chem/entities.ts';
import { molblock, pasteInto } from './helpers.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
}));

vi.mock('../src/api/client.ts', () => ({
  api: { listProfiles: async () => [], uploadAttachment: vi.fn() },
}));

const CONVERSATION = 'conv-paste';

const box = (): HTMLTextAreaElement => screen.getByLabelText('Message') as HTMLTextAreaElement;

const draft = (): string => useChatStore.getState().drafts[CONVERSATION] ?? '';

/** A reaction takes more await turns than a molecule, which is what inverts the two. */
const SUZUKI = 'Brc1ccccc1.OB(O)c1ccccc1>>c1ccc(-c2ccccc2)cc1';

beforeEach(() => {
  cleanup();
  useEntityStore.getState().clear();
  useChatStore.setState({
    conversations: {
      [CONVERSATION]: {
        id: CONVERSATION,
        sessionId: 'a'.repeat(32),
        sessionOrigin: 'local' as const,
        title: 'test',
        createdAt: 0,
        updatedAt: 0,
        messages: [],
        contextLost: false,
      },
    },
    order: [CONVERSATION],
    activeId: CONVERSATION,
    drafts: {},
    sessionProfiles: {},
    composerLock: false,
    banner: null,
    streaming: null,
  });
});

afterEach(cleanup);

describe('“Use the canonical form”', () => {
  it('rewrites the span that was pasted, not the first place the draft happens to spell it', async () => {
    render(<Composer conversationId={CONVERSATION} />);

    // Ethylene glycol is already in the sentence, and `OCC` — ethanol — is an infix of it. A
    // rewrite by value hits `OCCO` first and turns it into `CCOO`, ethyl hydroperoxide: a real,
    // valid, different compound, with the pasted token left untouched and nothing on screen
    // saying anything changed.
    fireEvent.change(box(), { target: { value: 'compare OCCO with ' } });
    pasteInto(box(), 'OCC', 18);

    await screen.findByText('Use the canonical form');
    fireEvent.click(screen.getByText('Use the canonical form'));

    expect(draft()).toBe('compare OCCO with CCO');
  });

  it('rewrites the second of two identical pastes when that is the one it is about', async () => {
    render(<Composer conversationId={CONVERSATION} />);

    fireEvent.change(box(), { target: { value: 'OCC and ' } });
    pasteInto(box(), 'OCC', 8);

    await screen.findByText('Use the canonical form');
    fireEvent.click(screen.getByText('Use the canonical form'));

    // Not `CCO and OCC`: the strip is about the paste, and the paste was the second one.
    expect(draft()).toBe('OCC and CCO');
  });

  it('is withdrawn once the text it describes has been edited', async () => {
    render(<Composer conversationId={CONVERSATION} />);

    pasteInto(box(), 'OCC', 0);
    await screen.findByText('Use the canonical form');

    // Kept typing: the token is now 2-chloroethanol, and the strip is still drawing ethanol over
    // it. Clicking it used to splice the canonical form into the middle of the edited token and
    // produce `CCOCl` — ethyl hypochlorite, shock-sensitive, and not what anybody confirmed.
    fireEvent.change(box(), { target: { value: 'OCCCl' } });

    await waitFor(() => expect(screen.queryByText('Use the canonical form')).toBeNull());
    expect(screen.queryByText(/Pasted structure/)).toBeNull();
    expect(draft()).toBe('OCCCl');
  });
});

describe('a paste the app cannot vouch for', () => {
  it('says so when RDKit refuses a token that looked like a structure', async () => {
    render(<Composer conversationId={CONVERSATION} />);

    // A ring bond that is never closed — a truncated or mistyped SMILES, and the thing a chemist
    // is most likely to paste by accident. The panel says this in words; the composer used to say
    // nothing at all, and the message went out asking for a hazard screen on it.
    pasteInto(box(), 'C1CCC', 0);

    const strip = await screen.findByRole('alert');
    expect(strip.textContent).toMatch(/could not read this as a molecule/i);
    expect(strip.textContent).toContain('C1CCC');
    // Still not intercepted: the text is in the message, and the chemist decides what to do.
    expect(draft()).toBe('C1CCC');

    fireEvent.click(screen.getByLabelText('Dismiss the structure check'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('stays quiet about a token that never looked like chemistry', async () => {
    render(<Composer conversationId={CONVERSATION} />);

    // `CCXQ` fails the syntactic recogniser, so RDKit is never asked and there is nothing to
    // report. A refusal strip here would fire on ordinary words.
    pasteInto(box(), 'CCXQ', 0);

    await waitFor(() => expect(draft()).toBe('CCXQ'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('two pastes in a row', () => {
  it('never lets the older answer describe the newer paste', async () => {
    render(<Composer conversationId={CONVERSATION} />);

    // The reaction resolves last — `readStructure` awaits every component of both sides — so
    // without a sequence guard the strip settles on the paste before last, and its button acts on
    // that older string.
    pasteInto(box(), SUZUKI, 0);
    // A space between them, so both spans stay whole tokens: this test is about which answer
    // wins, not about the token check that the previous describe covers.
    fireEvent.change(box(), { target: { value: `${SUZUKI} ` } });
    pasteInto(box(), 'CCO', SUZUKI.length + 1);

    const strip = await screen.findByRole('status');
    expect(strip.textContent).toContain('Pasted structure');
    expect(strip.textContent).not.toContain('Pasted reaction');
    // And the reaction's answer does not arrive late and take the strip back.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole('status').textContent).not.toContain('Pasted reaction');
  });
});

describe('a molblock on the clipboard', () => {
  it('is read as the structure it is, rather than pasted as prose', async () => {
    render(<Composer conversationId={CONVERSATION} />);

    // What ChemDraw, Ketcher and Marvin actually put on the clipboard. The file-drop path parses
    // byte-identical content happily; the paste path discarded it for containing whitespace, so
    // ten lines of MDL went into the message with no strip and no rail row.
    const block = molblock(['C', 'C', 'O'], '');
    pasteInto(box(), block, 0);

    const strip = await screen.findByRole('status');
    expect(strip.textContent).toContain('Pasted molfile');
    expect(strip.textContent).toContain('CCO');

    fireEvent.click(screen.getByText('Use the SMILES instead'));
    expect(draft()).toBe('CCO');
  });
});
