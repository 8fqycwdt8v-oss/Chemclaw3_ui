/**
 * "Delete conversation" deletes the conversation.
 *
 * It was a local map delete. The server session, its transcript, its checkpoints, its attachments
 * and its ownership row all survived — so a chemist who deleted a conversation *because* it held
 * something they did not want kept had been told something untrue by a control that looked like it
 * had done what it said. The service has a twelve-table transactional sweep for exactly this,
 * framed in its own docstring as "I do not want this conversation any more".
 *
 * It was also one click on a 24-pixel control, with no confirmation and no undo, in a codebase that
 * confirms the plan decision, the protocol status move, a job cancellation and "Clear all
 * conversations" — every one of them less final than this.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { SidebarBody } from '../src/components/Sidebar.tsx';
import { useChatStore } from '../src/state/chatStore.ts';

vi.mock('../src/auth/AuthContext.tsx', () => {
  const value = { auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true };
  return { useAuth: () => value, useIsReviewer: () => true };
});

const SESSION = 'a'.repeat(32);
const deletes: string[] = [];
let deleteStatus = 204;
let restore: (() => void) | null = null;

function serve(): void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'DELETE') {
      deletes.push(url);
      return Promise.resolve(
        deleteStatus === 204
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify({ detail: 'no' }), {
              status: deleteStatus,
              headers: { 'content-type': 'application/json' },
            }),
      );
    }
    // The sessions listing this panel reads on mount.
    return Promise.resolve(
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  }) as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
}

/** One conversation with a live server session behind it. */
function seed(): string {
  const id = useChatStore.getState().createConversation();
  useChatStore.getState().appendUserMessage(id, 'a question worth deleting');
  useChatStore.getState().setSessionId(id, SESSION);
  return id;
}

/**
 * Open the row's menu and reach for Delete.
 *
 * `pointerDown` rather than `click`: Radix's menu trigger opens on the pointer event, and a bare
 * `click` in happy-dom leaves the menu shut — which reads as "the item is missing" rather than as
 * "the menu never opened". Then Enter on the item, because a `click` on a Radix `MenuItem` does
 * not run `onSelect`.
 */
const openMenu = async (): Promise<void> => {
  const trigger = await screen.findByRole('button', { name: /Actions for/ });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  const item = await screen.findByRole('menuitem', { name: /Delete conversation/ });
  fireEvent.keyDown(item, { key: 'Enter' });
};

beforeEach(() => {
  cleanup();
  deletes.length = 0;
  deleteStatus = 204;
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
  serve();
});

afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

const mount = (): void => {
  render(
    <MemoryRouter>
      <SidebarBody />
    </MemoryRouter>,
  );
};

describe('deleting one conversation', () => {
  it('asks first, and does nothing until the answer', async () => {
    const id = seed();
    mount();
    await openMenu();

    expect(deletes).toEqual([]);
    expect(useChatStore.getState().conversations[id]).toBeDefined();
    expect(await screen.findByText(/removed from this browser and from the server/)).toBeTruthy();
  });

  it('deletes it on the server as well as here', async () => {
    const id = seed();
    mount();
    await openMenu();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete it' }));

    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0]).toContain(`/sessions/${SESSION}`);
    await waitFor(() => expect(useChatStore.getState().conversations[id]).toBeUndefined());
  });

  it('keeps the conversation when the server refused', async () => {
    // "It is gone" is the claim this control exists to make true, so a failure leaves the row
    // there to try again rather than removing it locally and reporting success.
    deleteStatus = 500;
    const id = seed();
    mount();
    await openMenu();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete it' }));

    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(useChatStore.getState().conversations[id]).toBeDefined();
    expect(useChatStore.getState().banner?.text).toContain('not deleted on the server');
  });

  it('treats a 404 as already gone', async () => {
    // The service answers 404 for both "no such session" and "not yours", deliberately, so as not
    // to be an id oracle. A conversation this browser holds a stale id for is one that is gone.
    deleteStatus = 404;
    const id = seed();
    mount();
    await openMenu();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete it' }));

    await waitFor(() => expect(useChatStore.getState().conversations[id]).toBeUndefined());
    expect(useChatStore.getState().banner).toBeNull();
  });

  it('does not call the service for a conversation that never had a session', async () => {
    // Warmed sessions mean most conversations have one, but a brand-new local conversation does
    // not, and asking the service to delete an id that does not exist is a round trip for nothing.
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().appendUserMessage(id, 'never sent');
    mount();
    await openMenu();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete it' }));

    await waitFor(() => expect(useChatStore.getState().conversations[id]).toBeUndefined());
    expect(deletes).toEqual([]);
  });
});
