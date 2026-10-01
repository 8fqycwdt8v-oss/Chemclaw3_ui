/**
 * The plan inbox lists plans in conversations this person does not own (Chemclaw3 #499).
 *
 * A member's own turn in somebody else's session can write a plan only that member may decide, and
 * `GET /plans/pending` now finds it. The row does not say whose conversation it is, and the one way
 * from the row into the conversation is `/open/<id>` — which, for a session nobody had adopted yet,
 * created an *owner's* stub: Delete and Branch on a conversation that is somebody else's, and a 404
 * read as a dead handle to replace with a private session (quietly moving the member's next question
 * out of the shared thread). So the row says whose it is, and opening it adopts it as shared.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ReviewQueue } from '../src/components/ReviewQueue.tsx';
import { useChatStore } from '../src/state/chatStore.ts';
import { queryClient } from '../src/api/queryClient.ts';
import type { PendingPlan, SharedSessionSummary } from '../src/api/client.ts';

vi.mock('../src/auth/AuthContext.tsx', () => {
  const value = { auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true };
  return { useAuth: () => value, useIsReviewer: () => true };
});

const OWNED = 'a'.repeat(32);
const SHARED = 'b'.repeat(32);

const plan = (session_id: string, title: string): PendingPlan => ({
  session_id,
  title,
  updated_at: '2026-10-01T09:00:00Z',
  plan_hash: `hash-${session_id.slice(0, 4)}`,
  plan: ['Screen three bases', 'Record the best in the ELN'],
});

const SHARED_ROW: SharedSessionSummary = {
  session_id: SHARED,
  owner: 'alice',
  title: 'Buchwald scale-up',
  added_at: '2026-09-30T08:05:00Z',
};

let restore: (() => void) | null = null;

function serve(shared: SharedSessionSummary[]): void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.includes('/plans/pending')) {
      return Promise.resolve(
        json({
          plans: [plan(OWNED, 'My own route scouting'), plan(SHARED, 'Buchwald scale-up')],
          considered: 2,
          gated: 2,
          unread: 0,
          truncated: false,
        }),
      );
    }
    if (url.includes('/sessions/shared')) return Promise.resolve(json(shared));
    if (/\/pending$/.test(url)) return Promise.resolve(json({ requests: [], count: 0 }));
    return Promise.resolve(json([]));
  }) as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
}

const mount = (): void => {
  render(
    <MemoryRouter initialEntries={['/review']}>
      <Routes>
        <Route path="/review" element={<ReviewQueue />} />
        <Route path="/open/:sessionId" element={<p>opened</p>} />
      </Routes>
    </MemoryRouter>,
  );
};

beforeEach(() => {
  cleanup();
  queryClient.clear();
  useChatStore.setState({ conversations: {}, order: [], activeId: null });
});

afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

describe('a plan in somebody else’s conversation', () => {
  it('says whose conversation it is, and only on that row', async () => {
    serve([SHARED_ROW]);
    mount();

    expect(await screen.findByText('Shared by alice')).toBeTruthy();
    // One badge: the plan in a conversation this person owns is not marked.
    expect(screen.getAllByText(/Shared by|Shared with you/)).toHaveLength(1);
  });

  it('opens it as a shared conversation, not as one of this person’s own', async () => {
    serve([SHARED_ROW]);
    mount();
    await screen.findByText('Shared by alice');

    const links = screen.getAllByRole('link', { name: 'Open the conversation to decide' });
    const toShared = links.find((link) => link.getAttribute('href') === `/open/${SHARED}`);
    expect(toShared).toBeTruthy();
    fireEvent.click(toShared!);

    await waitFor(() => expect(screen.getByText('opened')).toBeTruthy());
    const adopted = Object.values(useChatStore.getState().conversations).find(
      (c) => c.sessionId === SHARED,
    );
    expect(adopted?.membership).toEqual({ owner: 'alice' });
  });

  it('reads a service with no shared listing as nothing shared, not as a broken inbox', async () => {
    serve([]);
    mount();

    expect(await screen.findByText('My own route scouting')).toBeTruthy();
    expect(screen.getByText('Buchwald scale-up')).toBeTruthy();
    expect(screen.queryByText(/Shared by|Shared with you/)).toBeNull();
  });
});
