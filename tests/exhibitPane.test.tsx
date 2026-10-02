/**
 * The artefact pane's shell: the resizer a keyboard can move, the auto-open rule, the per-account
 * width, and the decision between the entity rail and the tabbed pane.
 *
 * Each of these is a property somebody could break without any view changing, which is why they
 * are asserted here rather than left to the browser tier: a separator only a mouse can move passes
 * every visual check, and an auto-open that ignores the reader's close looks like a feature.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { Resizer } from '../src/components/exhibits/Resizer.tsx';
import { RightColumn } from '../src/components/exhibits/RightColumn.tsx';
import { ExhibitCard } from '../src/components/exhibits/ExhibitCard.tsx';
import { exhibitArrived, exhibitPushed } from '../src/state/exhibitEvents.ts';
import {
  PANE_DEFAULT_PX,
  PANE_MAX_PX,
  PANE_MIN_PX,
  hydrateExhibitPaneForAccount,
  paneStorageKey,
  useExhibitPane,
} from '../src/state/exhibitPane.ts';
import { useChatStore, newConversation } from '../src/state/chatStore.ts';
import { keys, queryClient } from '../src/api/queryClient.ts';
import type { ExhibitEvent } from '../shared/events.ts';
import { stubFetch } from './helpers.ts';
import { VIEW } from './exhibitFixtures.ts';

vi.mock('../src/auth/AuthContext.tsx', () => {
  const value = { auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true };
  return { useAuth: () => value, useIsReviewer: () => true };
});

const SID = 'a'.repeat(32);
const XID = VIEW.exhibit_id;

const created = (over: Partial<ExhibitEvent> = {}): ExhibitEvent => ({
  type: 'exhibit',
  exhibit_id: XID,
  revision: 1,
  kind: 'table',
  title: 'Solvent ranking',
  op: 'created',
  author_kind: 'agent',
  author: 'chemclaw',
  ...over,
});

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let restore: (() => void) | null = null;

beforeEach(() => {
  useExhibitPane.setState({
    open: false,
    sheetOpen: false,
    tab: 'artefacts',
    focus: null,
    revision: 0,
    dismissedThisTurn: false,
    widthPx: PANE_DEFAULT_PX,
    refs: {},
  });
});

afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

describe('the resizer', () => {
  function Harness(): React.JSX.Element {
    const [width, setWidth] = useState(PANE_DEFAULT_PX);
    return <Resizer width={width} onResize={setWidth} controls="pane" />;
  }

  it('is a separator a keyboard can move, announcing its value and its bounds', () => {
    render(<Harness />);
    const handle = screen.getByRole('separator', { name: 'Resize the artefact pane' });
    expect(handle.getAttribute('aria-valuenow')).toBe(String(PANE_DEFAULT_PX));
    expect(handle.getAttribute('aria-valuemin')).toBe(String(PANE_MIN_PX));
    expect(handle.getAttribute('aria-valuemax')).toBe(String(PANE_MAX_PX));
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('tabindex')).toBe('0');

    // The pane is on the right, so Left widens it: the handle moves the way the key points.
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle.getAttribute('aria-valuenow')).toBe(String(PANE_DEFAULT_PX + 16));
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    expect(handle.getAttribute('aria-valuenow')).toBe(String(PANE_DEFAULT_PX - 64));
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(handle.getAttribute('aria-valuenow')).toBe(String(PANE_MIN_PX));
    // Clamped, never past the bound however often it is pressed.
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle.getAttribute('aria-valuenow')).toBe(String(PANE_MIN_PX));
    fireEvent.keyDown(handle, { key: 'End' });
    expect(handle.getAttribute('aria-valuenow')).toBe(String(PANE_MAX_PX));
  });

  it('follows a pointer drag, captured, widening as the pointer moves left', () => {
    render(<Harness />);
    const handle = screen.getByRole('separator');
    fireEvent.pointerDown(handle, { clientX: 800, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 760, pointerId: 1 });
    expect(handle.getAttribute('aria-valuenow')).toBe(String(PANE_DEFAULT_PX + 40));
    fireEvent.pointerUp(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 600, pointerId: 1 });
    expect(handle.getAttribute('aria-valuenow')).toBe(String(PANE_DEFAULT_PX + 40));
  });
});

describe('the auto-open rule', () => {
  it('opens the column on an artefact the agent created during the turn', () => {
    useExhibitPane.getState().turnStarted();
    exhibitArrived(SID, created());
    const state = useExhibitPane.getState();
    expect(state.open).toBe(true);
    expect(state.focus).toEqual({ sessionId: SID, exhibitId: XID });
    // The column only: a modal sheet sliding over a phone mid-answer is the app taking the screen.
    expect(state.sheetOpen).toBe(false);
  });

  it('does not reopen it when the reader closed the pane during this turn', () => {
    useExhibitPane.getState().turnStarted();
    exhibitArrived(SID, created());
    useExhibitPane.getState().close();
    exhibitArrived(SID, created({ exhibit_id: 'xb-1111111111111111' }));
    expect(useExhibitPane.getState().open).toBe(false);

    // The next question re-arms it.
    useExhibitPane.getState().turnStarted();
    exhibitArrived(SID, created({ exhibit_id: 'xb-2222222222222222' }));
    expect(useExhibitPane.getState().open).toBe(true);
    expect(useExhibitPane.getState().focus?.exhibitId).toBe('xb-2222222222222222');
  });

  it('never opens on a revision, nor on a push from somebody else', () => {
    useExhibitPane.getState().turnStarted();
    exhibitArrived(SID, created({ op: 'revised', revision: 2 }));
    exhibitPushed(SID);
    expect(useExhibitPane.getState().open).toBe(false);
  });

  it('refetches the session’s artefacts on every frame, whichever way it arrived', () => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    exhibitArrived(SID, created({ op: 'revised' }));
    exhibitPushed(SID);
    const invalidated = spy.mock.calls.map(([filters]) => filters?.queryKey);
    expect(
      invalidated.filter((key) => JSON.stringify(key) === JSON.stringify(keys.exhibits(SID))),
    ).toHaveLength(2);
    spy.mockRestore();
  });
});

describe('the width is the reader’s, per account', () => {
  it('persists under the account’s own key and is clamped when read back', async () => {
    localStorage.setItem(
      paneStorageKey('oid-wide'),
      JSON.stringify({ state: { widthPx: 99_999 }, version: 1 }),
    );
    hydrateExhibitPaneForAccount('oid-wide');
    await waitFor(() => expect(useExhibitPane.getState().widthPx).toBe(PANE_MAX_PX));

    act(() => useExhibitPane.getState().setWidth(512));
    const stored = JSON.parse(localStorage.getItem(paneStorageKey('oid-wide')) ?? '{}') as {
      state?: { widthPx?: number };
    };
    expect(stored.state).toEqual({ widthPx: 512 });
  });
});

describe('the right column', () => {
  const CONVERSATION = 'c-exhibits';

  beforeEach(() => {
    const conversation = { ...newConversation(), id: CONVERSATION, sessionId: SID };
    useChatStore.setState({
      viewer: 'chemist@example.com',
      conversations: { [CONVERSATION]: conversation },
      order: [CONVERSATION],
      activeId: CONVERSATION,
    });
  });

  const stubService = (enabled: boolean): void => {
    const stub = stubFetch((url) => {
      if (url.endsWith(`/sessions/${SID}/exhibits`)) {
        return json(200, { enabled, exhibits: [VIEW] });
      }
      if (url.includes(`/exhibits/${XID}/revisions`)) {
        return json(200, {
          revisions: [
            {
              ...VIEW,
              revision: 1,
              author_kind: 'agent',
              author: 'chemclaw',
              byte_size: 120,
              created_at: VIEW.created_at,
            },
            { ...VIEW, byte_size: 130, created_at: VIEW.updated_at },
          ],
        });
      }
      if (url.includes(`/exhibits/${XID}`)) return json(200, VIEW);
      return json(404, { detail: 'not found' });
    });
    restore = stub.restore;
  };

  it('is the entity rail until the pane is opened, and the tabbed pane after', async () => {
    stubService(true);
    const { container } = render(<RightColumn conversationId={CONVERSATION} />);
    // Closed: no pane, and no column at all for a conversation with nothing indexed yet.
    await waitFor(() => expect(container.querySelector('aside')).toBeNull());

    act(() => useExhibitPane.getState().show(SID, XID));
    const pane = await screen.findByRole('complementary', { name: 'Artefacts' });
    expect(pane).toBeTruthy();
    const tab = await screen.findByRole('tab', { name: 'Artefacts (1)' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Index (0)' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Solvent ranking' })).toBeTruthy();
    // The head is a person's correction, and the reader is that person.
    expect(screen.getByText('edited by you')).toBeTruthy();
    // The picker names each revision the way the contract writes it.
    const picker = await screen.findByRole('combobox', { name: 'Revision' });
    await waitFor(() =>
      expect(picker.textContent).toMatch(/r2 · you · \d\d:\d\d \(latest\)r1 · agent · \d\d:\d\d/),
    );
    // The unverified figure, above the table.
    expect(screen.getByRole('note').textContent).toBe(
      'Not found in any tool result this session (unchecked — not necessarily wrong): 82',
    );
    expect(screen.getByRole('separator', { name: 'Resize the artefact pane' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close the artefact pane' }));
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Artefacts' })).toBeNull(),
    );
    expect(useExhibitPane.getState().dismissedThisTurn).toBe(true);
  });

  it('never appears where the deployment has artefacts turned off', async () => {
    stubService(false);
    act(() => useExhibitPane.getState().show(SID, XID));
    render(<RightColumn conversationId={CONVERSATION} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('complementary', { name: 'Artefacts' })).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
  });
});

describe('the card in the answer', () => {
  it('names the artefact, the revision this turn wrote, the head and who edited it', async () => {
    useChatStore.setState({ viewer: 'somebody-else' });
    const stub = stubFetch(() => json(200, { enabled: true, exhibits: [VIEW] }));
    restore = stub.restore;
    render(
      <ExhibitCard
        sessionId={SID}
        exhibit={{
          exhibitId: XID,
          revision: 1,
          kind: '',
          title: '',
          op: 'created',
          authorKind: 'agent',
          author: '',
        }}
      />,
    );
    // The title comes off the list — a card rebuilt from a reloaded transcript has none.
    expect(await screen.findByText('Solvent ranking')).toBeTruthy();
    expect(screen.getByText('created rev 1')).toBeTruthy();
    expect(screen.getByText('now rev 2')).toBeTruthy();
    expect(screen.getByText('edited by chemist@example.com')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Open artefact Solvent ranking' }));
    expect(useExhibitPane.getState()).toMatchObject({
      open: true,
      sheetOpen: true,
      focus: { sessionId: SID, exhibitId: XID },
    });
  });
});
