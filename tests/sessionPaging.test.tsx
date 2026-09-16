/**
 * What the conversation list's "Load earlier conversations" control does after a page fails.
 *
 * Nothing tested this, and the hand-rolled cursor state that `@tanstack/react-query` replaced had
 * a property the replacement silently dropped: the control went away once a page had failed. The
 * comment left behind claimed `hasNextPage` carried that property over, and it does not.
 * `hasNextPage` is `getNextPageParam(lastSuccessfulPage)`, and a *failed* fetch never reaches
 * `getNextPageParam` — measured on the installed `@tanstack/query-core` with this app's own
 * defaults, page 1 advertising a cursor and page 2 throwing lands on
 * `{status:'error', hasNextPage:true, pages:1}`. So the button stayed, and every press re-issued
 * the same refused cursor for ever.
 *
 * Restoring the old behaviour would be wrong in the other direction, because the old code treated
 * every failure as final. The service refuses a cursor it did not mint with a **422**, which is
 * final for this listing; a **503** or a dropped connection is not, and there the same button is
 * the remedy. `ApiError.retryable` is what tells them apart, which is the flag `sendMessage`
 * already reads to decide whether a banner offers Retry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { SidebarBody } from '../src/components/Sidebar.tsx';
import { useChatStore } from '../src/state/chatStore.ts';

vi.mock('../src/auth/AuthContext.tsx', () => {
  const value = { auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true };
  return { useAuth: () => value, useIsReviewer: () => true };
});

/** One page per answer, in order — so a case can say "page 2 fails, then works". */
type Answer =
  | { sessions: { session_id: string; created_at: string; title: string }[]; next?: string }
  | { status: number; detail: string };

function serveSessions(answers: Answer[]) {
  const asked: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    asked.push(url);
    const answer = answers[asked.length - 1] ?? { sessions: [] };
    if ('status' in answer) {
      return Promise.resolve(
        new Response(JSON.stringify({ detail: answer.detail }), {
          status: answer.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (answer.next) headers['x-next-cursor'] = answer.next;
    return Promise.resolve(new Response(JSON.stringify(answer.sessions), { status: 200, headers }));
  }) as typeof fetch;
  return {
    asked,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const page = (title: string, next?: string): Answer => ({
  sessions: [{ session_id: title.padEnd(32, 'x'), created_at: '2026-01-01T00:00:00Z', title }],
  ...(next ? { next } : {}),
});

let restore: (() => void) | null = null;

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

const loadMore = () => screen.queryByRole('button', { name: /Load earlier conversations/ });
const retryMore = () => screen.queryByRole('button', { name: /Retry loading earlier/ });

describe('a page the service refuses finally', () => {
  it('takes the control away rather than offering a retry that cannot work', async () => {
    // `GET /sessions` answers a cursor it did not mint with `422 not a session cursor`. Pressing
    // the button again re-sends that same cursor, so the only honest thing left is to stop
    // offering it.
    const stub = serveSessions([
      page('page one', 'cursor-2'),
      { status: 422, detail: 'not a session cursor' },
    ]);
    restore = stub.restore;
    mount();

    const more = await screen.findByRole('button', { name: /Load earlier conversations/ });
    more.click();

    await waitFor(() => expect(loadMore()).toBeNull());
    expect(retryMore()).toBeNull();
    // Two requests: the first page, and the one that was refused. No third is reachable, because
    // there is no longer a control to press.
    expect(stub.asked).toHaveLength(2);
    expect(stub.asked[1]).toContain('after=cursor-2');
  });

  it('says so where the control was, instead of vanishing silently', async () => {
    // The pre-`react-query` code cleared the cursor, which removed the button with no sentence —
    // and a list that stops offering more reads as a list that is complete.
    const stub = serveSessions([
      page('page one', 'cursor-2'),
      { status: 422, detail: 'not a session cursor' },
    ]);
    restore = stub.restore;
    mount();

    (await screen.findByRole('button', { name: /Load earlier conversations/ })).click();

    expect(await screen.findByText(/Could not load earlier conversations/)).toBeTruthy();
    // And not the footer's local-only note, which would be false: page one is on screen.
    expect(screen.queryByText(/Showing local conversations only/)).toBeNull();
    expect(screen.getByText('page one')).toBeTruthy();
  });
});

describe('a page that failed transiently', () => {
  it('keeps the control, as a retry that says it is one — and the retry works', async () => {
    // 503 is `capacity`, which `ApiError` marks retryable: the service is at capacity now and will
    // not be in a moment, and the cursor is still good. Removing the button here would strand the
    // rest of the listing behind a blip.
    const stub = serveSessions([
      page('page one', 'cursor-2'),
      { status: 503, detail: 'The service is at capacity. Retry shortly.' },
      page('page two'),
    ]);
    restore = stub.restore;
    mount();

    (await screen.findByRole('button', { name: /Load earlier conversations/ })).click();

    const retry = await screen.findByRole('button', { name: /Retry loading earlier/ });
    retry.click();

    expect(await screen.findByText('page two')).toBeTruthy();
    // The listing resumed from the cursor it was refused on, rather than starting over.
    expect(stub.asked).toHaveLength(3);
    expect(stub.asked[2]).toContain('after=cursor-2');
    // Back to an ordinary control-free end of list: page two advertised no cursor.
    await waitFor(() => expect(retryMore()).toBeNull());
    expect(loadMore()).toBeNull();
    expect(screen.queryByText(/Could not load earlier conversations/)).toBeNull();
  });
});

describe('the first page failing is a different failure', () => {
  it('is the local-only note, and offers no page control at all', async () => {
    // No page arrived, so `getNextPageParam` was never called and there is no cursor to offer.
    // This is the one case the old comment described correctly — and the only one in which
    // "showing local conversations only" is true.
    const stub = serveSessions([{ status: 503, detail: 'The service is at capacity.' }]);
    restore = stub.restore;
    mount();

    expect(await screen.findByText(/Showing local conversations only/)).toBeTruthy();
    expect(loadMore()).toBeNull();
    expect(retryMore()).toBeNull();
    expect(screen.queryByText(/Could not load earlier conversations/)).toBeNull();
  });
});
