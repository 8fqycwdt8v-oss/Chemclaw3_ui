/**
 * Getting work out of the app, and not losing work inside it.
 *
 * Four gaps that share a shape: the product is used all day by people who put its output somewhere
 * else, and every route out of it was missing.
 *
 *  - **Copy an answer.** `navigator.clipboard` appeared exactly once in `src/` — on the crash
 *    screen. Getting an answer into an ELN meant selecting and dragging it out of the DOM, which
 *    takes the citation chips and the result tables with it. `DownloadCsv` already makes the
 *    argument for the table case in its own docstring: "retyped into Excel is where the
 *    transcription error enters a campaign".
 *  - **Print a protocol.** `@media print` appeared nowhere, on the one artefact `ProtocolDocument`
 *    describes as the thing "a chemist has to be able to check line by line before anything is
 *    charged into a vessel" — which happens at a bench, on paper.
 *  - **Edit and resend.** A turn that *failed* put its text back in the draft; one that succeeded
 *    and answered the wrong question did not, so the chemist retyped the question — SMILES and all.
 *  - **The protocol editor's unsaved work.** The one screen where a human writes, in a Radix
 *    dialog that closes on Escape or a click outside, mounted as `{editing && …}` so closing
 *    unmounts the draft. No confirmation, no draft, nothing to undo.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageList } from '../src/components/MessageList.tsx';
import { ProtocolEditor } from '../src/components/ProtocolEditor.tsx';
import { PREFILL_EVENT, type PrefillDetail } from '../src/state/composerEvents.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import type { DesignOut } from '../shared/protocols.ts';

vi.mock('../src/auth/AuthContext.tsx', () => {
  const value = { auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true };
  return { useAuth: () => value, useIsReviewer: () => true };
});

/** A conversation with one settled answer in it. */
function seedAnswer(text: string): string {
  const cid = useChatStore.getState().createConversation();
  useChatStore.getState().appendUserMessage(cid, 'what is the pKa of acetic acid');
  const mid = useChatStore.getState().startAssistantMessage(cid);
  useChatStore.getState().applyEvent(cid, mid, {
    type: 'answer',
    text,
    confidence: null,
    unsupported_claims: [],
    review_required: false,
    verified_by: null,
  });
  useChatStore.getState().finishTurn(cid, mid, 'done');
  return cid;
}

beforeEach(() => {
  cleanup();
  useChatStore.setState({
    conversations: {},
    order: [],
    activeId: null,
    drafts: {},
    composerLock: false,
    banner: null,
    jobFeed: [],
    streaming: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('an answer a chemist wants to keep', () => {
  it('goes to the clipboard as the markdown the service sent', async () => {
    const written: string[] = [];
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: {
        writeText: (t: string) => {
          written.push(t);
          return Promise.resolve();
        },
      },
    });
    const answer = 'The pKa is **4.76** in water at 25 °C. See `note-acetic-1`.';
    const cid = seedAnswer(answer);
    render(<MessageList conversationId={cid} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy this answer' }));

    // The markdown, not the rendered DOM: the emphasis marks and the citation token are what make
    // this paste-able into an ELN and still mean the same thing.
    await waitFor(() => expect(written).toEqual([answer]));
    expect(await screen.findByText('Copied')).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('says so, rather than failing silently, when the browser refuses', async () => {
    // An insecure origin, a denied permission, an old WebView. The reader still has to be able to
    // get the text — the same posture `CrashScreen` takes about its diagnostics.
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    const cid = seedAnswer('an answer');
    render(<MessageList conversationId={cid} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy this answer' }));

    expect(await screen.findByText(/select the text instead/)).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('offers nothing to copy while the answer is still arriving', () => {
    // Copying half an answer is copying the wrong thing.
    const cid = useChatStore.getState().createConversation();
    useChatStore.getState().appendUserMessage(cid, 'q');
    const mid = useChatStore.getState().startAssistantMessage(cid);
    useChatStore.getState().appendTokens(cid, mid, 'The pKa is ');
    render(<MessageList conversationId={cid} />);

    expect(screen.queryByRole('button', { name: 'Copy this answer' })).toBeNull();
  });
});

describe('a question that was answered, but not the one that was asked', () => {
  it('goes back into the composer without being re-posted', () => {
    // `sendMessage` records that "nothing in this app has ever re-posted a turn on the user's
    // behalf", and that line is worth keeping — so this refills and stops. The human presses Send.
    const seen: PrefillDetail[] = [];
    window.addEventListener(PREFILL_EVENT, (e) =>
      seen.push((e as CustomEvent<PrefillDetail>).detail),
    );
    const cid = seedAnswer('4.76');
    render(<MessageList conversationId={cid} />);

    fireEvent.click(screen.getByRole('button', { name: /Edit and resend/ }));

    // A bare string is the no-send form of the prefill contract.
    expect(seen).toEqual(['what is the pKa of acetic acid']);
  });
});

/**
 * The smallest design the editor will render, with one setpoint to change.
 *
 * Typed as `DesignOut` rather than left as a literal, so `tsc -b` — already a CI step — is the
 * drift check: a field renamed on the protocol contract fails here instead of leaving this fixture
 * describing a shape the service stopped sending.
 */
const design = (): DesignOut => ({
  design_id: 'd-1',
  summary: null,
  revision: 3,
  kind: 'protocol',
  author_kind: 'agent',
  author: 'agent',
  checks: [],
  history: [],
  status_history: [],
  design: {
    request: {
      title: 'Nitration screen',
      objective: { value: 'selectivity', provenance: 'stated', quote: '' },
      constraints: [],
      substrates: [],
    },
    base: {
      setpoints: {
        temperature_c: 60,
        time_h: 4,
        pressure_bar: null,
        concentration_molar: null,
        ph: null,
        solvent: 'MeCN',
        atmosphere: 'N2',
      },
      charge: [],
      steps: [],
      analytics: [],
    },
    factors: [],
    arms: [],
    plate: null,
    hazards: [],
    evidence: [],
  } as never,
  change_note: '',
  created_at: '2026-09-01T00:00:00Z',
});

describe('the one screen where a human writes', () => {
  const editor = (onOpenChange: (open: boolean) => void) =>
    render(
      <ProtocolEditor
        designId="d-1"
        revision={design()}
        open
        onOpenChange={onOpenChange}
        onSaved={() => {}}
        onReload={() => {}}
      />,
    );

  it('refuses to close on an edited form, and says what would be lost', () => {
    const closes: boolean[] = [];
    editor((next) => closes.push(next));

    fireEvent.change(screen.getByLabelText(/Temperature/), { target: { value: '75' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Not closed — and told why.
    expect(closes).toEqual([]);
    expect(screen.getByText(/edits that have not been saved/)).toBeTruthy();
  });

  it('closes on the second, deliberate answer', () => {
    const closes: boolean[] = [];
    editor((next) => closes.push(next));

    fireEvent.change(screen.getByLabelText(/Temperature/), { target: { value: '75' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: /Discard my edits/ }));

    expect(closes).toEqual([false]);
  });

  it('closes straight away when nothing was typed', () => {
    // The guard must not stand between a reader and the close button on a form they only looked at.
    const closes: boolean[] = [];
    editor((next) => closes.push(next));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(closes).toEqual([false]);
  });

  it('treats a value typed and typed back as no edit at all', () => {
    // Why the check is a comparison rather than a dirty flag: 60 to 70 and back to 60 is not an
    // edit, and a flag would still refuse the close.
    const closes: boolean[] = [];
    editor((next) => closes.push(next));

    const field = screen.getByLabelText(/Temperature/);
    fireEvent.change(field, { target: { value: '70' } });
    fireEvent.change(field, { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(closes).toEqual([false]);
  });
});
