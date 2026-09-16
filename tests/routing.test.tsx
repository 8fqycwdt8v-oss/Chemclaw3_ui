/**
 * The URL and the store, and what keeps them from fighting.
 *
 * The URL is the source of truth for *which* conversation; the store follows it. The one place
 * that pushes the other way is a reconciler for a conversation that has disappeared out from
 * under the reader. Both of the failure modes below were real:
 *
 *  - A symmetrical `activeId !== routeId → navigate` mirror deadlocks the Back button. The
 *    browser rewinds the URL, the follow effect selects the older conversation, and the mirror
 *    runs in the same pass still closed over the *newer* `activeId`, so it navigates forward
 *    again — then back, forever. An e2e run caught it alternating until the test timed out.
 *  - The same mirror bounces a link to an id this device never had to whatever else happens to
 *    be open, so the panel explaining why it is missing is never seen.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { useChatStore } from '../src/state/chatStore.ts';
import { AuthGate } from '../src/auth/AuthContext.tsx';
import { AppRoutes } from '../src/routes.tsx';
import { jsonError, stubFetch } from './helpers.ts';

/** Reports every path the router settles on, so a loop shows up as a growing list. */
const visited: string[] = [];

function Recorder(): null {
  const { pathname } = useLocation();
  if (visited[visited.length - 1] !== pathname) visited.push(pathname);
  return null;
}

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Recorder />
      <AuthGate>
        <Routes>
          <Route path="*" element={<AppRoutes />} />
        </Routes>
      </AuthGate>
    </MemoryRouter>,
  );

let restore: (() => void) | null = null;

afterEach(() => {
  // Unmount before the fetch stub goes away: the shell's health poll and job streams are still
  // running, and an in-flight request that lands after teardown surfaces as an unhandled error
  // attributed to whichever test happens to be next.
  cleanup();
  restore?.();
  restore = null;
});

beforeEach(() => {
  cleanup();
  // The shell mounts the health poll, the session list and the job streams. None of them is what
  // these tests are about; 404 is the quietest answer the client already knows how to absorb.
  restore = stubFetch(() => jsonError(404, 'not found')).restore;
  visited.length = 0;
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

describe('URL ↔ store', () => {
  it('adopts the conversation the URL names, in one pass', () => {
    const a = useChatStore.getState().createConversation();
    const b = useChatStore.getState().createConversation();
    expect(useChatStore.getState().activeId).toBe(b);

    renderAt(`/c/${a}`);

    expect(useChatStore.getState().activeId).toBe(a);
    // One settled path. Anything more is the two effects taking turns.
    expect(visited).toEqual([`/c/${a}`]);
  });

  it('does not navigate away while the URL names a conversation that exists', () => {
    // The Back case in miniature: the store is pointing at `b` and the URL has just rewound to
    // `a`. Following the URL is the only correct move; reconciling to `activeId` undoes Back.
    const a = useChatStore.getState().createConversation();
    const b = useChatStore.getState().createConversation();

    renderAt(`/c/${a}`);
    expect(visited).toEqual([`/c/${a}`]);
    expect(useChatStore.getState().activeId).toBe(a);
    expect(useChatStore.getState().conversations[b]).toBeTruthy();
  });

  it('explains an unknown conversation instead of redirecting to the open one', () => {
    const a = useChatStore.getState().createConversation();

    renderAt('/c/not-a-real-id');

    expect(screen.getByText(/isn’t on this device/)).toBeTruthy();
    expect(visited).toEqual(['/c/not-a-real-id']);
    // And it must not have quietly adopted something else on the way.
    expect(useChatStore.getState().activeId).toBe(a);
  });

  it('follows the store when the open conversation is deleted', () => {
    // The one thing the reconciler is for: `deleteConversation` falls through to `order[0]` and
    // nothing navigates, so the URL would otherwise point at a conversation that no longer exists.
    const a = useChatStore.getState().createConversation();
    const b = useChatStore.getState().createConversation();

    renderAt(`/c/${b}`);
    expect(visited).toEqual([`/c/${b}`]);

    act(() => useChatStore.getState().deleteConversation(b));

    expect(visited).toEqual([`/c/${b}`, `/c/${a}`]);
  });
});

/**
 * W30.6 — `ISSUES.md` Issue 5. The second-device link says what it is.
 *
 * Every session-scoped route upstream resolves through `_refuse_unless_owner`, which 404s a
 * non-owner indistinguishably from an unknown id. So this link cannot be handed to a colleague,
 * and three user-visible strings said it could: the sidebar row read "Shared conversation", a
 * mistyped link was answered with "A shared link ends in…", and the spinner said "Opening the
 * shared conversation…". The route itself was `/s/`.
 *
 * Asserted against what is *rendered* and against the store, never against the file: `routes.tsx`
 * quotes all three of the old strings in the paragraph explaining why they are gone, so a
 * file-wide `toContain` would pass with the change reverted and fail with it applied — which is
 * the shape this repository has shipped before.
 */
describe('a link to a session this device has never seen', () => {
  it('adopts it under a name that does not promise sharing', async () => {
    const sessionId = 'c'.repeat(32);
    renderAt(`/open/${sessionId}`);
    await act(async () => {
      await Promise.resolve();
    });

    const adopted = Object.values(useChatStore.getState().conversations).find(
      (c) => c.sessionId === sessionId,
    );
    expect(adopted?.title).toBe('Conversation from another device');
  });

  it('tells a truncated link what a conversation link is, not what a shared link is', async () => {
    renderAt('/open/nonsense');
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      await screen.findByText(/A conversation link ends in a 32-character session id/),
    ).toBeTruthy();
  });

  it('explains the old /s/ link rather than opening a blank new conversation on it', async () => {
    // The decision not to keep `/s/` as a redirect was argued on this link landing on "That
    // conversation isn't on this device — the honest message anyway". It did not. With no route
    // of its own it fell through the catch-all to `/`, and driven through this same router an old
    // bookmark ended at `/c/<a fresh id>`: no error, nothing adopted, no mention of the link. A
    // reader sees an empty conversation and reads it as "mine was lost", which is worse than a
    // 404 rather than the better thing the argument claimed.
    const sessionId = 'c'.repeat(32);
    renderAt(`/s/${sessionId}`);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(/That link has moved/)).toBeTruthy();
    // It names the path that works now — the id on the end of the reader's bookmark is the same.
    expect(screen.getByText(/\/open\//)).toBeTruthy();
    // Nowhere: the URL the reader arrived on is the URL they are still on. Three entries here is
    // the redirect coming back.
    expect(visited).toEqual([`/s/${sessionId}`]);
    // And nothing was minted or adopted on the way — the empty conversation is what made the old
    // behaviour read as a loss.
    expect(Object.keys(useChatStore.getState().conversations)).toEqual([]);
  });
});
