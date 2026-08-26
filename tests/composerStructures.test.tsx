/**
 * The composer's three structure paths, none of which existed before.
 *
 * The one worth stating plainly is the paste. `StructureInput` is built on the rule that a chemist
 * must never send a structure they have not seen, and for a while the fastest way in went straight
 * round it: pasting a SMILES put an unchecked string into the message with no drawing, no
 * canonicalisation and no rail row. These tests are what stop that regressing, because the failure
 * mode is silence — the app looks exactly the same, it just stops checking.
 *
 * The drop tests cover a second silence: a page with no drop handler hands the file to the browser,
 * which navigates to it and takes the draft and the app with it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Composer } from '../src/components/Composer.tsx';
import { useChatStore } from '../src/state/chatStore.ts';
import { useEntityStore, entitiesOf } from '../src/chem/entities.ts';
import { insertStructure } from '../src/state/composerEvents.ts';
import { pasteInto } from './helpers.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
}));

vi.mock('../src/api/client.ts', () => ({
  api: { listProfiles: async () => [], uploadAttachment: vi.fn() },
}));

const CONVERSATION = 'conv-structures';

const box = (): HTMLTextAreaElement => screen.getByLabelText('Message') as HTMLTextAreaElement;

/** happy-dom has no DataTransfer worth constructing, so hand `fireEvent` the shape React reads. */
function fileDrop(files: File[]): { dataTransfer: unknown } {
  return { dataTransfer: { files, types: ['Files'], items: files } };
}

/**
 * Paste `text` at `at`, the way a browser does it — the paste event first, with the caret still at
 * the insertion point, and the insertion afterwards. The composer records that caret as the span
 * the confirmation is about, so the order is not a detail: setting the value first and firing
 * `paste` afterwards describes a paste that landed at the end of the draft, wherever it went.
 */
function paste(text: string, at?: number): void {
  pasteInto(box(), text, at);
}

// Unmount before the environment is torn down, not merely before the next test. The composer
// schedules a `requestAnimationFrame` to restore the caret after an insert, and React schedules
// its own work; either landing after happy-dom has gone throws `window is not defined` as an
// unhandled error, which vitest exits non-zero on even with every test green.
afterEach(() => {
  cleanup();
});

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

describe('a pasted structure', () => {
  it('is drawn back with what RDKit made of it, without intercepting the paste', async () => {
    render(<Composer conversationId={CONVERSATION} />);

    // The paste itself lands normally — the component never calls preventDefault, so the browser
    // has already inserted the text by the time we look.
    paste('BrC1=CC=C(OC)C=C1', 0);

    const strip = await screen.findByRole('status');
    expect(strip.textContent).toContain('Pasted structure');
    // The canonical form, which is not what was pasted — that difference is the whole reason the
    // strip offers anything at all.
    expect(strip.textContent).toContain('COc1ccc(Br)cc1');
    expect(box().value).toBe('BrC1=CC=C(OC)C=C1');
  });

  it('admits the compound to the rail under its canonical key', async () => {
    render(<Composer conversationId={CONVERSATION} />);

    paste('BrC1=CC=C(OC)C=C1', 0);

    await waitFor(() => {
      const slice = entitiesOf(useEntityStore.getState(), CONVERSATION);
      expect(Object.keys(slice.entities)).toContain('COc1ccc(Br)cc1');
    });
    // Filed as pasted, so the rail's provenance line can say where it came from.
    const entity = entitiesOf(useEntityStore.getState(), CONVERSATION).entities['COc1ccc(Br)cc1'];
    expect(entity?.mentions[0]?.source).toBe('paste');
  });

  it('replaces the pasted spelling in place, keeping the sentence around it', async () => {
    render(<Composer conversationId={CONVERSATION} />);

    fireEvent.change(box(), { target: { value: 'screen  for hazards' } });
    paste('BrC1=CC=C(OC)C=C1', 7);
    await screen.findByText('Use the canonical form');

    fireEvent.click(screen.getByText('Use the canonical form'));
    expect(box().value).toBe('screen COc1ccc(Br)cc1 for hazards');
  });

  it('offers nothing to replace when the paste was already canonical', async () => {
    render(<Composer conversationId={CONVERSATION} />);

    paste('CCO', 0);

    const strip = await screen.findByRole('status');
    expect(strip.textContent).toContain('CCO');
    // A button that would rewrite the message to exactly what it already says is noise.
    expect(screen.queryByText('Use the canonical form')).toBeNull();
  });

  it('says nothing about a paste that is prose, or a token RDKit refuses', async () => {
    render(<Composer conversationId={CONVERSATION} />);

    // Multi-token: a structure arrives as one token and a pasted procedure does not, which is what
    // keeps the WASM off the path of somebody pasting half an SOP.
    paste('add the bromide slowly', 0);
    // Single token, and one the syntactic recogniser refuses outright — so RDKit is never asked,
    // and there is nothing for the strip to report either way.
    paste('CCXQ');

    // Nothing to wait *for*, so wait for the thing that would have appeared and assert it did
    // not: `readStructure` refuses both before RDKit is ever asked, so a tick is enough.
    await waitFor(() => expect(screen.queryByText(/Pasted structure/)).toBeNull());
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('a dropped file', () => {
  it('opens the structure panel already holding a .mol', async () => {
    render(<Composer conversationId={CONVERSATION} />);

    fireEvent.drop(
      document.getElementById('composer')!,
      fileDrop([new File(['ignored by the stub'], 'ethanol.mol', { type: '' })]),
    );

    // The panel is open, which is what "pre-loaded" means from the outside: no second click.
    await screen.findByText('Insert a structure');
  });

  it('sends anything else to the attachment route rather than to the structure panel', async () => {
    render(<Composer conversationId={CONVERSATION} />);

    fireEvent.drop(
      document.getElementById('composer')!,
      fileDrop([new File(['a,b\n1,2'], 'runs.csv', { type: 'text/csv' })]),
    );

    await waitFor(() => expect(screen.queryByText(/Uploading runs\.csv/)).toBeTruthy());
    expect(screen.queryByText('Insert a structure')).toBeNull();
  });
});

describe('chemclaw:insert-structure', () => {
  it('inserts at the caret and leaves the rest of the draft alone', async () => {
    render(<Composer conversationId={CONVERSATION} />);

    fireEvent.change(box(), { target: { value: 'what is the pKa of  at 25 C' } });
    box().setSelectionRange(19, 19);

    act(() => {
      insertStructure('COc1ccc(Br)cc1');
    });

    await waitFor(() =>
      expect(useChatStore.getState().drafts[CONVERSATION]).toBe(
        'what is the pKa of COc1ccc(Br)cc1 at 25 C',
      ),
    );
  });

  it('never sends — turning a structure into a question is the chemist’s job', async () => {
    render(<Composer conversationId={CONVERSATION} />);

    act(() => {
      insertStructure('CCO');
    });

    await waitFor(() => expect(useChatStore.getState().drafts[CONVERSATION]).toContain('CCO'));
    expect(useChatStore.getState().streaming).toBeNull();
  });
});
