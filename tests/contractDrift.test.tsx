/**
 * Three fields the service sends and this client used to throw away.
 *
 * Each was a capability the backend built, shipped and documented, that never reached a surface —
 * and in every case the client's own prose recorded the *old* state of the service as though it
 * were current. That is the failure mode this file exists to catch: not a bug in either side, but a
 * client that stopped reading.
 *
 *  - `SessionSummary.title` / `updated_at`. `Sidebar.tsx` carried "the server has never sent one,
 *    so the guard was decoration in front of a constant" — deleted one release before
 *    `routes/sessions.py` began sending a title. So every restored conversation read "Earlier
 *    conversation" until somebody opened it, and sorted by when it was *started* rather than when
 *    it was last touched, which the same file's sort comment names as the bug.
 *  - `X-Next-Cursor`. The service caps a listing at `service_max_listed_sessions` and advertises
 *    the cursor. Nothing read it, so conversation 101 was not below a fold — it was never fetched.
 *  - `TranscriptToolCall.result_ref`. The service does a *second* read purely to populate it,
 *    whose docstring calls it "the one path on which the ref never reached a surface". It did not,
 *    because the interface here declared three fields of four.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { SidebarBody } from '../src/components/Sidebar.tsx';
import { transcriptToMessages } from '../src/state/transcript.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import type { SessionSummary, TranscriptMessage } from '../src/api/client.ts';

vi.mock('../src/auth/AuthContext.tsx', () => {
  const value = { auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true };
  return { useAuth: () => value, useIsReviewer: () => true };
});

/** `GET /sessions`, answering with a page and optionally advertising a next one. */
function serveSessions(pages: { sessions: SessionSummary[]; next?: string }[]) {
  const asked: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    asked.push(url);
    const after = new URL(url, 'http://x').searchParams.get('after') ?? '';
    const index = after ? Number(after) : 0;
    const page = pages[index] ?? { sessions: [] };
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (page.next) headers['x-next-cursor'] = page.next;
    return Promise.resolve(new Response(JSON.stringify(page.sessions), { status: 200, headers }));
  }) as typeof fetch;
  return {
    asked,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

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

describe('a conversation restored from the service', () => {
  it('is named by the service rather than labelled "Earlier conversation"', async () => {
    const stub = serveSessions([
      {
        sessions: [
          {
            session_id: 'a'.repeat(32),
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-09-01T00:00:00Z',
            title: 'Impurity profile for the nitration',
          },
        ],
      },
    ]);
    restore = stub.restore;
    mount();

    expect(await screen.findByText('Impurity profile for the nitration')).toBeTruthy();
    expect(screen.queryByText('Earlier conversation')).toBeNull();
  });

  it('still says "Earlier conversation" when the service has no name for it', async () => {
    // A session minted before anyone spoke, and a service that predates the field, are the same
    // thing to a reader: there is no name. The placeholder is the honest answer, not a fallback
    // that should have been deleted with the guard.
    const stub = serveSessions([
      {
        sessions: [{ session_id: 'b'.repeat(32), created_at: '2026-01-01T00:00:00Z', title: null }],
      },
    ]);
    restore = stub.restore;
    mount();

    expect(await screen.findByText('Earlier conversation')).toBeTruthy();
  });

  it('is ordered by its last activity, not by when it was started', async () => {
    const stub = serveSessions([
      {
        sessions: [
          {
            session_id: 'c'.repeat(32),
            created_at: '2026-01-01T00:00:00Z',
            // Opened in January and abandoned.
            updated_at: '2026-01-01T00:05:00Z',
            title: 'opened last Tuesday and abandoned',
          },
          {
            session_id: 'd'.repeat(32),
            // Started later still, but touched an hour ago.
            created_at: '2026-02-01T00:00:00Z',
            updated_at: '2026-09-04T23:00:00Z',
            title: 'used an hour ago',
          },
        ],
      },
    ]);
    restore = stub.restore;
    mount();

    await screen.findByText('used an hour ago');
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    const recent = rows.findIndex((t) => t.includes('used an hour ago'));
    const stale = rows.findIndex((t) => t.includes('opened last Tuesday'));
    expect(recent).toBeGreaterThanOrEqual(0);
    expect(recent).toBeLessThan(stale);
  });
});

describe('a listing longer than one page', () => {
  it('offers the next page, and does not offer one when the service did not', async () => {
    const stub = serveSessions([
      {
        sessions: [
          { session_id: 'e'.repeat(32), created_at: '2026-01-01T00:00:00Z', title: 'page one' },
        ],
        next: '1',
      },
      {
        sessions: [
          { session_id: 'f'.repeat(32), created_at: '2026-01-01T00:00:00Z', title: 'page two' },
        ],
      },
    ]);
    restore = stub.restore;
    mount();

    const more = await screen.findByRole('button', { name: /Load earlier conversations/ });
    more.click();

    expect(await screen.findByText('page two')).toBeTruthy();
    // The second page advertised no cursor, so there is nothing left to offer.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Load earlier conversations/ })).toBeNull(),
    );
    // And the cursor really was sent, rather than the same page being asked for twice.
    expect(stub.asked.some((u) => u.includes('after=1'))).toBe(true);
  });

  it('shows no control at all when one page was the whole listing', async () => {
    const stub = serveSessions([
      {
        sessions: [
          { session_id: 'g'.repeat(32), created_at: '2026-01-01T00:00:00Z', title: 'the only one' },
        ],
      },
    ]);
    restore = stub.restore;
    mount();

    await screen.findByText('the only one');
    expect(screen.queryByRole('button', { name: /Load earlier conversations/ })).toBeNull();
  });
});

describe('a rehydrated tool call', () => {
  it('carries the content address, so the full result is still openable', () => {
    // Live, `tool_result.result_ref` is what makes `ResultBlock` and `ResultSheet` reachable. This
    // is the same fact recovered from storage, and dropping it is why every full result became a
    // 400-character paraphrase the moment the page was reloaded.
    const remote: TranscriptMessage[] = [
      { index: 0, role: 'user', text: 'screen this for hazards', tool_calls: [] },
      {
        index: 1,
        role: 'assistant',
        text: 'Two structural alerts fired.',
        tool_calls: [
          {
            tool: 'screen_hazards',
            arguments: '{"smiles":"CCO"}',
            result: 'a 400-character preview…',
            result_ref: 'sha256:beef',
          },
        ],
      },
    ];

    const messages = transcriptToMessages(remote);
    const assistant = messages.find((m) => m.role === 'assistant');
    const call = assistant?.role === 'assistant' ? assistant.trace[0]?.toolCall : undefined;

    expect(call?.resultRef).toBe('sha256:beef');
  });

  it('leaves it absent when the service no longer holds the result', () => {
    // Swept, or never stored. The service deliberately does not tell those apart, because the only
    // consumer that acts on this cannot: either way there is nothing to fetch.
    const messages = transcriptToMessages([
      { index: 0, role: 'user', text: 'q', tool_calls: [] },
      {
        index: 1,
        role: 'assistant',
        text: 'a',
        tool_calls: [{ tool: 't', arguments: '{}', result: 'preview', result_ref: '' }],
      },
    ]);
    const assistant = messages.find((m) => m.role === 'assistant');
    const call = assistant?.role === 'assistant' ? assistant.trace[0]?.toolCall : undefined;

    expect(call?.resultRef).toBeUndefined();
  });
});
