/**
 * A document streamed while the agent writes it (`exhibit_draft`, artefacts wave 2): it opens the
 * pane the way a new artefact does, grows as frames arrive, draws over an artefact being revised,
 * is replaced by the real artefact when the `exhibit` frame lands, and is gone when a turn ends
 * without one.
 *
 * Each rule here is one the contract states and nothing on screen would flag if it broke: a draft
 * that outlived a refused tool call reads as a document that exists; one that vanished before its
 * artefact had loaded is a blank column mid-answer; a live region over its body reads a report
 * aloud in fragments.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { RightColumn } from '../src/components/exhibits/RightColumn.tsx';
import { PaneBody } from '../src/components/exhibits/ExhibitPane.tsx';
import { useFrameThrottled } from '../src/components/exhibits/views/DraftView.tsx';
import {
  draftArrived,
  draftToolFailed,
  draftsEnded,
  exhibitArrived,
} from '../src/state/exhibitEvents.ts';
import {
  createDraftOf,
  draftsOf,
  reviseDraftOf,
  useExhibitDrafts,
} from '../src/state/exhibitDrafts.ts';
import { PANE_DEFAULT_PX, useExhibitPane } from '../src/state/exhibitPane.ts';
import { newConversation, useChatStore } from '../src/state/chatStore.ts';
import { sendMessage } from '../src/state/sendMessage.ts';
import { keys, queryClient } from '../src/api/queryClient.ts';
import type { AuthProvider } from '../src/auth/types.ts';
import type { ExhibitDraftEvent, ExhibitEvent } from '../shared/events.ts';
import { answerEvent, sseFrames, sseResponse, stubFetch } from './helpers.ts';
import { VIEW } from './exhibitFixtures.ts';

vi.mock('../src/auth/AuthContext.tsx', () => {
  const value = { auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true };
  return { useAuth: () => value, useIsReviewer: () => true };
});

const SID = 'a'.repeat(32);
const XID = VIEW.exhibit_id;
const NEW_XID = 'xb-fedcba9876543210';
const CONVERSATION = 'c-on-screen';

const draft = (over: Partial<ExhibitDraftEvent> = {}): ExhibitDraftEvent => ({
  type: 'exhibit_draft',
  call_id: 'toolu_01',
  op: 'create',
  exhibit_id: '',
  kind: 'document',
  title: 'Process report',
  markdown: '# Process report',
  done: false,
  ...over,
});

const exhibit = (over: Partial<ExhibitEvent> = {}): ExhibitEvent => ({
  type: 'exhibit',
  exhibit_id: NEW_XID,
  revision: 1,
  kind: 'document',
  title: 'Process report',
  op: 'created',
  author_kind: 'agent',
  author: 'chemclaw',
  ...over,
});

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const devAuth: AuthProvider = {
  mode: 'dev',
  account: null,
  getAccessToken: async () => null,
  login: async () => undefined,
  logout: async () => undefined,
  handleUnauthorized: async () => false,
};

let restore: (() => void) | null = null;

beforeEach(() => {
  useExhibitDrafts.setState({ drafts: {} });
  useExhibitPane.setState({
    open: false,
    sheetOpen: false,
    tab: 'artefacts',
    focus: {},
    dismissedThisTurn: false,
    widthPx: PANE_DEFAULT_PX,
    refs: {},
  });
  const conversation = { ...newConversation(), id: CONVERSATION, sessionId: SID };
  useChatStore.setState({
    conversations: { [CONVERSATION]: conversation },
    order: [CONVERSATION],
    activeId: CONVERSATION,
    streaming: null,
    composerLock: false,
    banner: null,
  });
});

afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe('a new document being drafted', () => {
  it('opens the column on its first frame, by the auto-open rule, and never the sheet', () => {
    useExhibitPane.getState().turnStarted();
    draftArrived(SID, draft());
    expect(useExhibitPane.getState().open).toBe(true);
    expect(useExhibitPane.getState().sheetOpen).toBe(false);
    expect(createDraftOf(useExhibitDrafts.getState(), SID)?.markdown).toBe('# Process report');
  });

  it('does not reopen a pane the reader closed this turn', () => {
    useExhibitPane.getState().turnStarted();
    useExhibitPane.getState().close();
    draftArrived(SID, draft());
    expect(useExhibitPane.getState().open).toBe(false);
    // It is still held: the reader can open the pane on it.
    expect(createDraftOf(useExhibitDrafts.getState(), SID)).not.toBeNull();
  });

  it('opens nothing for a conversation that is not on screen', () => {
    useChatStore.setState({ activeId: null });
    draftArrived(SID, draft());
    expect(useExhibitPane.getState().open).toBe(false);
  });

  it('only grows: a frame no longer than the text held is a repeat, not a rewrite', () => {
    draftArrived(SID, draft({ markdown: '# Process report\n\nThe amination' }));
    draftArrived(SID, draft({ markdown: '# Process' }));
    expect(createDraftOf(useExhibitDrafts.getState(), SID)?.markdown).toBe(
      '# Process report\n\nThe amination',
    );
    draftArrived(SID, draft({ markdown: '# Process report\n\nThe amination ran in 2-MeTHF.' }));
    expect(createDraftOf(useExhibitDrafts.getState(), SID)?.markdown).toMatch(/2-MeTHF\.$/);
  });

  it('keeps two calls apart by call id, and ignores a kind that is not a document', () => {
    draftArrived(SID, draft({ call_id: 'a' }));
    draftArrived(SID, draft({ call_id: 'b', title: 'Second' }));
    draftArrived(SID, draft({ call_id: 'c', kind: 'table' }));
    expect(draftsOf(useExhibitDrafts.getState(), SID).map((d) => d.callId)).toEqual(['a', 'b']);
  });

  it('is shown in the pane as a draft, growing, before the session has any artefact', async () => {
    const stub = stubFetch(() => json(200, { enabled: true, exhibits: [] }));
    restore = stub.restore;
    useExhibitPane.getState().turnStarted();
    act(() => draftArrived(SID, draft()));
    render(<RightColumn conversationId={CONVERSATION} />);

    const pane = await screen.findByRole('complementary', { name: 'Artefacts' });
    expect(await screen.findByRole('heading', { name: 'Drafting “Process report”…' })).toBeTruthy();
    // One polite status for the whole draft — never a live region over the text itself.
    const status = screen.getByRole('status');
    expect(status.textContent).toMatch(/being written now/);
    const body = pane.querySelector('[aria-busy="true"]')!;
    expect(body.closest('[aria-live]')).toBeNull();
    // Not a document yet: nothing to edit, export or compare.
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();

    act(() =>
      draftArrived(SID, draft({ markdown: '# Process report\n\nThe amination ran in 2-MeTHF.' })),
    );
    await waitFor(() => expect(pane.textContent).toContain('The amination ran in 2-MeTHF.'));
    expect(screen.getByRole('status').textContent).toMatch(/being written now/);
  });
});

describe('replacement and discard', () => {
  it('is replaced by the next created artefact of the turn, and only once the list has it', async () => {
    let listed: unknown[] = [];
    const stub = stubFetch(() => json(200, { enabled: true, exhibits: listed }));
    restore = stub.restore;
    // A list query must exist for the invalidation to refetch.
    await queryClient.fetchQuery({
      queryKey: keys.exhibits(SID),
      queryFn: async () => (await fetch('/x')).json(),
    });
    useExhibitPane.getState().turnStarted();
    draftArrived(SID, draft());

    listed = [{ ...VIEW, exhibit_id: NEW_XID, kind: 'document' }];
    exhibitArrived(SID, exhibit());
    // Settled, but still on screen until the refetch has answered.
    expect(createDraftOf(useExhibitDrafts.getState(), SID)?.settledAs).toBe(NEW_XID);
    expect(useExhibitPane.getState().focus[SID]?.exhibitId).toBe(NEW_XID);
    await waitFor(() => expect(createDraftOf(useExhibitDrafts.getState(), SID)).toBeNull());
  });

  it('matches creates in call order, and a revise by the artefact it names', () => {
    draftArrived(SID, draft({ call_id: 'first' }));
    draftArrived(SID, draft({ call_id: 'second' }));
    draftArrived(SID, draft({ call_id: 'rev', op: 'revise', exhibit_id: XID }));
    exhibitArrived(SID, exhibit({ exhibit_id: 'xb-1111111111111111' }));
    exhibitArrived(SID, exhibit({ exhibit_id: XID, op: 'revised', revision: 3 }));
    const held = draftsOf(useExhibitDrafts.getState(), SID);
    expect(held.find((d) => d.callId === 'first')?.settledAs).toBe('xb-1111111111111111');
    expect(held.find((d) => d.callId === 'second')?.settledAs).toBeNull();
    expect(held.find((d) => d.callId === 'rev')?.settledAs).toBe(XID);
  });

  it('settles by call id: a refused create’s draft never takes its retry’s artefact', () => {
    // Scenario A. The first document create is refused; the agent retries.
    draftArrived(SID, draft({ call_id: 'refused', markdown: '# Old' }));
    draftArrived(SID, draft({ call_id: 'retry', markdown: '# New' }));
    exhibitArrived(SID, exhibit({ call_id: 'retry' }));
    const held = draftsOf(useExhibitDrafts.getState(), SID);
    expect(held.find((d) => d.callId === 'retry')?.settledAs).toBe(NEW_XID);
    expect(held.find((d) => d.callId === 'refused')?.settledAs).toBeNull();
    // A frame naming a call that streamed nothing settles nothing.
    exhibitArrived(SID, exhibit({ call_id: 'never-streamed', exhibit_id: 'xb-2222222222222222' }));
    expect(
      draftsOf(useExhibitDrafts.getState(), SID).filter((d) => d.settledAs !== null),
    ).toHaveLength(1);
  });

  it('never lets a table settle a streaming document, with or without a call id', () => {
    // Scenario B: a table and a document created in parallel.
    draftArrived(SID, draft({ call_id: 'doc' }));
    exhibitArrived(
      SID,
      exhibit({ kind: 'table', exhibit_id: 'xb-3333333333333333', call_id: 'table' }),
    );
    exhibitArrived(SID, exhibit({ kind: 'table', exhibit_id: 'xb-4444444444444444' }));
    expect(createDraftOf(useExhibitDrafts.getState(), SID)?.settledAs).toBeNull();
    // An older service's frame with no call id still settles the document by order.
    exhibitArrived(SID, exhibit({ kind: 'document' }));
    expect(createDraftOf(useExhibitDrafts.getState(), SID)?.settledAs).toBe(NEW_XID);
  });

  it('discards a draft as soon as its tool call fails, oldest of that op first', () => {
    draftArrived(SID, draft({ call_id: 'refused' }));
    draftArrived(SID, draft({ call_id: 'rev', op: 'revise', exhibit_id: XID }));
    const failed = (tool: string) =>
      draftToolFailed(SID, {
        type: 'tool_failed',
        tool,
        message: 'spec too large',
        reason: null,
        agent: '',
      });
    failed('find_notes');
    expect(draftsOf(useExhibitDrafts.getState(), SID)).toHaveLength(2);
    failed('create_exhibit');
    expect(draftsOf(useExhibitDrafts.getState(), SID).map((d) => d.callId)).toEqual(['rev']);
    // The retry streams, and is the draft in front — the refused one is gone.
    draftArrived(SID, draft({ call_id: 'retry', markdown: '# Retry' }));
    expect(createDraftOf(useExhibitDrafts.getState(), SID)?.callId).toBe('retry');
    failed('revise_exhibit');
    expect(reviseDraftOf(useExhibitDrafts.getState(), SID, XID)).toBeNull();
  });

  it('is discarded when the turn ends without its artefact, and a settled one is left to land', () => {
    // The first create's `exhibit` frame settles the first draft in call order; the second call
    // was refused, so no frame ever names it.
    draftArrived(SID, draft({ call_id: 'landed' }));
    draftArrived(SID, draft({ call_id: 'refused' }));
    exhibitArrived(SID, exhibit());
    draftsEnded(SID);
    expect(draftsOf(useExhibitDrafts.getState(), SID).map((d) => d.callId)).toEqual(['landed']);
  });

  it('is gone after a real turn that streamed a draft and ended refused', async () => {
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/messages') && init?.method === 'POST') {
        return sseResponse(
          sseFrames([
            draft({ markdown: '# Process' }),
            draft({ markdown: '# Process report' }),
            {
              type: 'tool_failed',
              tool: 'create_exhibit',
              message: 'spec too large',
              reason: null,
              agent: '',
            },
            answerEvent({ text: 'I could not save the report.' }),
          ]),
        );
      }
      return json(200, { enabled: true, exhibits: [] });
    });
    restore = stub.restore;
    let most = 0;
    const unsubscribe = useExhibitDrafts.subscribe((s) => {
      most = Math.max(most, draftsOf(s, SID).length);
    });
    await sendMessage({ conversationId: CONVERSATION, text: 'write the report', auth: devAuth });
    unsubscribe();
    expect(most).toBe(1);
    expect(draftsOf(useExhibitDrafts.getState(), SID)).toEqual([]);
    // Never a trace row: a draft is not a step of the agent's work, and not part of the message.
    const message = useChatStore.getState().conversations[CONVERSATION]!.messages.at(-1)!;
    expect(message.role === 'assistant' && message.trace.some((t) => t.kind === 'exhibit')).toBe(
      false,
    );
  });
});

describe('an artefact being revised', () => {
  it('draws the agent’s new text over the artefact under a banner, until the revision lands', async () => {
    const documentView = {
      ...VIEW,
      kind: 'document',
      head_revision: 2,
      revision: 2,
      spec: { kind: 'document', markdown: 'The old text.' },
    };
    const stub = stubFetch((url) =>
      url.includes('/revisions') ? json(200, { revisions: [] }) : json(200, documentView),
    );
    restore = stub.restore;
    useExhibitPane.getState().show(SID, XID);
    render(
      <PaneBody
        conversationId={CONVERSATION}
        sessionId={SID}
        exhibits={[{ ...VIEW, kind: 'document' }] as never}
      />,
    );
    expect(await screen.findByText('The old text.')).toBeTruthy();

    act(() =>
      draftArrived(
        SID,
        draft({ call_id: 'rev', op: 'revise', exhibit_id: XID, markdown: 'The new text, half' }),
      ),
    );
    expect(
      await screen.findByRole('heading', { name: 'Being revised by the agent — Process report' }),
    ).toBeTruthy();
    expect(await screen.findByText('The new text, half')).toBeTruthy();
    expect(screen.queryByText('The old text.')).toBeNull();
    // The artefact's own header and history stay where they were.
    expect(screen.getByRole('heading', { name: 'Solvent ranking' })).toBeTruthy();
    expect(reviseDraftOf(useExhibitDrafts.getState(), SID, XID)).not.toBeNull();
    // A revise opens nothing on its own.
    expect(useExhibitPane.getState().open).toBe(true); // `show` above, not the draft
  });
});

describe('the render throttle', () => {
  it('draws at most once per animation frame, the last text of the frame winning', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames[id - 1] = () => undefined;
    });
    const { result, rerender } = renderHook(({ text }) => useFrameThrottled(text), {
      initialProps: { text: 'a' },
    });
    rerender({ text: 'ab' });
    rerender({ text: 'abc' });
    // Two frames were asked for along the way; only the latest is live.
    expect(result.current).toBe('a');
    act(() => frames.forEach((cb) => cb(0)));
    expect(result.current).toBe('abc');
  });
});
