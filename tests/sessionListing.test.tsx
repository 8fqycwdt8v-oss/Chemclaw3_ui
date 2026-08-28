/**
 * What `GET /sessions` now sends, and what the sidebar does with it.
 *
 * `SessionSummary` was `{session_id, created_at}` when this UI was written, and ISSUES.md Issue 4
 * records the consequence: every server-restored conversation is one identical "Earlier
 * conversation" row until somebody clicks it, and ordering by `created_at` puts a session opened
 * last Tuesday and abandoned above one used an hour ago. The fix it asks for — `title` and
 * `updated_at`, both off tables the listing already reads — has since shipped upstream.
 *
 * This side did not notice. `SessionSummary` here still declared two fields, so both arrived and
 * were dropped in transit, and the code comment in `Sidebar.tsx` said in the present tense that
 * "the server has never sent one" while it was sending one. That is the same shape as the six
 * `shared/events.ts` misses: a contract mirrored by hand in another repository, with nothing
 * mechanical between them.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { useChatStore } from '../src/state/chatStore.ts';
import { AuthGate } from '../src/auth/AuthContext.tsx';
import { Sidebar } from '../src/components/Sidebar.tsx';
import { stubFetch } from './helpers.ts';

const SID = 'b'.repeat(32);
const CREATED = '2026-08-20T09:00:00Z';
const UPDATED = '2026-08-27T17:30:00Z';

let restore: (() => void) | null = null;

/** Only the session listing matters here; everything else answers empty. */
function stubListing(body: unknown): void {
  const stub = stubFetch((url) => {
    if (url.includes('/sessions') && !url.includes('/messages')) {
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  restore = stub.restore;
}

const renderSidebar = () =>
  render(
    <MemoryRouter>
      <AuthGate>
        <Sidebar />
      </AuthGate>
    </MemoryRouter>,
  );

/** The one conversation the listing produced. */
const restored = () => Object.values(useChatStore.getState().conversations)[0];

beforeEach(() => {
  cleanup();
  useChatStore.setState({ conversations: {}, order: [], activeId: null });
});

afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

describe('a conversation restored from GET /sessions', () => {
  it('is named by the title the service sends, not by a placeholder', async () => {
    stubListing([
      { session_id: SID, created_at: CREATED, updated_at: UPDATED, title: 'Pd leaching in the 3L' },
    ]);
    renderSidebar();
    await waitFor(() => expect(restored()).toBeDefined());
    expect(restored()?.title).toBe('Pd leaching in the 3L');
    expect(screen.queryByText('Earlier conversation')).toBeNull();
  });

  it('is ordered by last activity, not by when the session was started', async () => {
    // The distinction Issue 4 names: `created_at` is "what did I once open", `updated_at` is
    // "what have I been working on". A week apart here, and the sidebar's recency column and its
    // ordering both read `updatedAt`.
    stubListing([
      { session_id: SID, created_at: CREATED, updated_at: UPDATED, title: 'Pd leaching' },
    ]);
    renderSidebar();
    await waitFor(() => expect(restored()).toBeDefined());
    expect(restored()?.updatedAt).toBe(Date.parse(UPDATED));
    expect(restored()?.createdAt).toBe(Date.parse(CREATED));
  });

  it('falls back to the placeholder when the service names nothing', async () => {
    // `title: null` is the service saying "this session's first turn predates the field", which is
    // a different thing from an empty name — and an older service omits the key entirely. Both
    // land on the placeholder the transcript read will replace.
    stubListing([{ session_id: SID, created_at: CREATED, updated_at: UPDATED, title: null }]);
    renderSidebar();
    await waitFor(() => expect(restored()).toBeDefined());
    expect(restored()?.title).toBe('Earlier conversation');
  });

  it('falls back to created_at when the service sends no updated_at', async () => {
    stubListing([{ session_id: SID, created_at: CREATED }]);
    renderSidebar();
    await waitFor(() => expect(restored()).toBeDefined());
    expect(restored()?.updatedAt).toBe(Date.parse(CREATED));
  });
});
