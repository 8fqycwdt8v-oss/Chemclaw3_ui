/**
 * The composer's ephemeral state belongs to one conversation, and must not follow the reader.
 *
 * This file's subject is the class of bug the composer's own docstring already records for the
 * draft: "As component state on a component that does not unmount when `conversationId` changes,
 * it leaked: you could type in one conversation, switch to another, and send the first one's text
 * into the second." The draft was moved to the store. Four things were left behind — the paste
 * confirmation, the upload notice, the structure panel and the dry-run switch — and they leak the
 * same way, because switching conversation only changes a prop here.
 *
 * The paste strip is the worst of them, because it also offers an action that cannot work. Its
 * button splices at a recorded *span* of the draft and correctly declines when the span has moved,
 * so in the next conversation — whose draft has never held that string — pressing "Use the
 * canonical form" writes nothing and says nothing. A control that is offered and then silently
 * does nothing is worse than one that is absent.
 *
 * The upload notice is the second worst: "Attached screen.csv (48 rows)." sitting over a
 * conversation whose session has no such attachment, because the file went to the session id
 * captured when the upload started.
 *
 * The upload's *request* is the other half of that one, and it outlives the composer entirely. Its
 * `AbortController` is reachable only through component state, and `AppShell` unmounts the
 * composer on `/review` and `/jobs` — both one click away in the sidebar while an upload runs. So
 * a 40 MB SOP kept uploading with its progress callback pointed at a dead tree, and coming back
 * re-mounted a composer with no progress bar, no Cancel, and no way to tell whether it landed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Composer } from '../src/components/Composer.tsx';
import { useChatStore } from '../src/state/chatStore.ts';
import { useEntityStore } from '../src/chem/entities.ts';
import { pasteInto } from './helpers.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
}));

type UploadArgs = [string, File, unknown, { signal: AbortSignal }];

const uploadAttachment = vi.fn(async (..._args: UploadArgs) => ({ name: 'screen.csv', rows: 48 }));

/** Make the next upload hang, and hand back the signal it was given. */
const hangingUpload = (): { signal: AbortSignal | null } => {
  const captured: { signal: AbortSignal | null } = { signal: null };
  uploadAttachment.mockImplementationOnce((...args: UploadArgs) => {
    captured.signal = args[3].signal;
    return new Promise(() => undefined);
  });
  return captured;
};

vi.mock('../src/api/client.ts', () => ({
  api: {
    listProfiles: async () => [],
    uploadAttachment: (...args: unknown[]) => uploadAttachment(...(args as UploadArgs)),
  },
}));

const A = 'conv-A';
const B = 'conv-B';

const conversation = (id: string, session: string) => ({
  id,
  sessionId: session,
  sessionOrigin: 'local' as const,
  title: id,
  createdAt: 0,
  updatedAt: 0,
  messages: [],
  contextLost: false,
});

const box = (): HTMLTextAreaElement => screen.getByLabelText('Message') as HTMLTextAreaElement;

/** Hand the composer a file the way the paperclip does. */
const attach = (container: HTMLElement): void => {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['a,b\n1,2'], 'screen.csv')] } });
};

beforeEach(() => {
  cleanup();
  uploadAttachment.mockClear();
  useEntityStore.getState().clear();
  useChatStore.setState({
    conversations: { [A]: conversation(A, 'a'.repeat(32)), [B]: conversation(B, 'b'.repeat(32)) },
    order: [A, B],
    activeId: A,
    drafts: {},
    sessionProfiles: {},
    composerLock: false,
    banner: null,
    streaming: null,
  });
});

afterEach(cleanup);

describe('switching conversation', () => {
  it('withdraws a settled paste confirmation, and its unusable button', async () => {
    // This one the span rule already delivers: the strip is bound to a span of *the draft*, and
    // switching conversation swaps the draft out from under it. Pinned so the fix below does not
    // regress it, and because it is the half the button depends on — `onReplace` declines when the
    // span has moved, so the button offered in B would write nothing and say nothing.
    const { rerender } = render(<Composer conversationId={A} />);

    pasteInto(box(), 'BrC1=CC=C(OC)C=C1', 0);
    expect(await screen.findByText(/COc1ccc\(Br\)cc1/)).toBeTruthy();
    expect(screen.getByText('Use the canonical form')).toBeTruthy();

    rerender(<Composer conversationId={B} />);

    expect(screen.queryByText(/COc1ccc\(Br\)cc1/)).toBeNull();
    expect(screen.queryByText('Use the canonical form')).toBeNull();
    expect(useChatStore.getState().drafts[B] ?? '').toBe('');
  });

  it('does not let a paste read that was still running land in the next conversation', async () => {
    // The realistic order, and the one the span rule cannot catch: paste, then switch before RDKit
    // has answered. The read resolves against a composer now showing B, `pasteLanded` is false and
    // B's draft still equals what A's was before the paste — so the withdrawal effect sees no edit
    // and the strip settles over the wrong conversation, permanently.
    const { rerender } = render(<Composer conversationId={A} />);

    pasteInto(box(), 'BrC1=CC=C(OC)C=C1', 0);
    rerender(<Composer conversationId={B} />);

    // "Never appears", not "is absent right now": the read is in flight, so a snapshot taken
    // before it resolves would pass against the broken code too.
    await expect(screen.findByText(/COc1ccc\(Br\)cc1/, {}, { timeout: 250 })).rejects.toThrow();
    expect(screen.queryByText('Use the canonical form')).toBeNull();
  });

  it('does not carry the attachment notice onto a conversation with no such attachment', async () => {
    const { container, rerender } = render(<Composer conversationId={A} />);

    attach(container);

    expect(await screen.findByText('Attached screen.csv (48 rows).')).toBeTruthy();

    rerender(<Composer conversationId={B} />);

    await waitFor(() => expect(screen.queryByText('Attached screen.csv (48 rows).')).toBeNull());
  });

  it('does not leave the structure panel open over the next conversation', () => {
    const { rerender } = render(<Composer conversationId={A} />);

    const hexagon = screen.getByLabelText('Insert a structure');
    fireEvent.click(hexagon);
    expect(hexagon.getAttribute('aria-expanded')).toBe('true');

    rerender(<Composer conversationId={B} />);

    expect(screen.getByLabelText('Insert a structure').getAttribute('aria-expanded')).toBe('false');
  });
});

describe('an upload the reader has walked away from', () => {
  it('is cancelled when the conversation changes', async () => {
    const captured = hangingUpload();
    const { container, rerender } = render(<Composer conversationId={A} />);

    attach(container);
    await waitFor(() => expect(captured.signal).not.toBeNull());
    expect(captured.signal?.aborted).toBe(false);

    rerender(<Composer conversationId={B} />);

    expect(captured.signal?.aborted).toBe(true);
  });

  it('is cancelled when the composer unmounts, which the sidebar does in one click', async () => {
    const captured = hangingUpload();
    const { container, unmount } = render(<Composer conversationId={A} />);

    attach(container);
    await waitFor(() => expect(captured.signal).not.toBeNull());

    unmount();

    expect(captured.signal?.aborted).toBe(true);
  });
});
