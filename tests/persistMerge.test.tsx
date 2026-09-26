/**
 * What the cross-tab fold (`mergeWithStored`) does when there is only one tab.
 *
 * The fold runs on every write, so in the commonest case there is — one tab — the "other tab's"
 * copy on disk is this tab's own previous write. Two things went wrong there, both invisible from
 * the store's API and observable only by driving a real write: a row this tab had trimmed at the
 * cap came back at the head of the list as the newest notice, and "Reset app" left the notices it
 * says it discards on disk for the next load to rehydrate.
 *
 * The module registry is reset per test for the reason `persistBudget.test.ts` gives —
 * `storageWritable` is module scope and latches.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { Digest } from '../src/api/client.ts';

vi.mock('../src/auth/AuthContext.tsx', () => {
  const value = { auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true };
  return { useAuth: () => value, useIsReviewer: () => true };
});

const KEY = 'chemclaw3.chat.v2.anon';

/** A store module of this test's own, and a `localStorage` it can read back. */
async function freshStore(store = new Map<string, string>()) {
  vi.resetModules();
  vi.stubGlobal('localStorage', {
    length: 0,
    key: () => null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return { store, ...(await import('../src/state/chatStore.ts')) };
}

const digest = (query: string): Digest =>
  ({ query, note_ids: [`note-${query}`], disputed: [], headlines: {} }) as unknown as Digest;

const storedQueries = (store: Map<string, string>): string[] =>
  (
    JSON.parse(store.get(KEY) ?? '{"state":{"digests":[]}}') as {
      state: { digests: { query: string }[] };
    }
  ).state.digests.map((d) => d.query);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('one tab past the cap', () => {
  it('writes to disk exactly the digests it holds in memory', async () => {
    // Measured before the fix: memory [q201 … q2], disk [q0, q201 … q3] — the oldest row, already
    // trimmed from memory, pinned at the head as the newest finding with a newer one evicted.
    vi.useFakeTimers({ toFake: ['Date'] });
    const { store, useChatStore, flushChatPersistence } = await freshStore();
    useChatStore.getState().createConversation();
    for (let i = 0; i <= 201; i++) {
      vi.setSystemTime(1_800_000_000_000 + i * 1_000);
      useChatStore.getState().addDigests([digest(`q${i}`)]);
      flushChatPersistence();
    }

    const inMemory = useChatStore.getState().digests.map((d) => d.query);
    expect(inMemory).toHaveLength(200);
    expect(inMemory[0]).toBe('q201');
    expect(storedQueries(store)).toEqual(inMemory);
  });

  it('keeps memory and disk equal when a whole batch shares one timestamp', async () => {
    // `addDigests` stamps a claimed batch with one `Date.now()`, so a tie between the rows this
    // tab kept and the ones it trimmed from the same batch is the ordinary case, not an edge.
    vi.useFakeTimers({ toFake: ['Date'] });
    const { store, useChatStore, flushChatPersistence } = await freshStore();
    useChatStore.getState().createConversation();
    vi.setSystemTime(1_800_000_000_000);
    useChatStore.getState().addDigests(Array.from({ length: 150 }, (_, i) => digest(`a${i}`)));
    flushChatPersistence();
    vi.setSystemTime(1_800_000_001_000);
    useChatStore.getState().addDigests(Array.from({ length: 100 }, (_, i) => digest(`b${i}`)));
    flushChatPersistence();

    expect(storedQueries(store)).toEqual(useChatStore.getState().digests.map((d) => d.query));
  });
});

describe('Reset app', () => {
  it('leaves no browser-only notice on disk for the next load to rehydrate', async () => {
    // `clearAll` alone emptied memory, and the next write folded the stored digest straight back
    // onto disk — so "discarded", as the dialog says, meant "until the next reload". Driven
    // through the dialog itself, because the defect was which function the button called.
    const store = new Map<string, string>();
    const first = await freshStore(store);
    first.useChatStore.getState().createConversation();
    first.useChatStore.getState().addDigests([digest('SECRET-QUERY')]);
    first.flushChatPersistence();
    expect(store.get(KEY) ?? '').toContain('SECRET-QUERY');

    const original = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
      )) as typeof fetch;
    try {
      const { SidebarBody } = await import('../src/components/Sidebar.tsx');
      render(
        <MemoryRouter>
          <SidebarBody />
        </MemoryRouter>,
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Reset app' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Reset everything' }));
    } finally {
      globalThis.fetch = original;
    }
    first.flushChatPersistence();
    expect(store.get(KEY) ?? '').not.toContain('SECRET-QUERY');

    const second = await freshStore(store);
    await second.useChatStore.persist.rehydrate();
    expect(second.useChatStore.getState().digests).toEqual([]);
  });
});

describe('stored notices past the age cutoff', () => {
  it('does not fold a digest or a job ending older than a week back onto disk', async () => {
    // `partialize` drops a row older than `JOB_FEED_MAX_AGE_MS`, and the fold then put every
    // stored row this tab did not know straight back — so the dropped row was written again,
    // rehydrated, dropped, and written again, for ever. A fresh row of each kind rides along, so
    // the assertion is about the cutoff rather than about the fold discarding stored rows at all.
    const WEEK = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const stale = now - WEEK - 1_000;
    const card = (query: string, receivedAt: number) => ({
      query,
      noteIds: [`note-${query}`],
      receivedAt,
      dismissed: false,
    });
    const job = (jobId: string, receivedAt: number) => ({
      event: { job_id: jobId, status: 'completed' },
      sessionId: 'sess-1',
      conversationId: null,
      receivedAt,
      seen: false,
      dismissed: false,
    });
    const store = new Map<string, string>();
    store.set(
      KEY,
      JSON.stringify({
        version: 3,
        state: {
          conversations: {},
          order: [],
          activeId: null,
          drafts: {},
          jobFeed: [job('STALE-JOB', stale), job('FRESH-JOB', now)],
          digests: [card('STALE-DIGEST', stale), card('FRESH-DIGEST', now)],
          checkIns: [],
          notifyOnJobComplete: false,
        },
      }),
    );
    const { useChatStore, flushChatPersistence } = await freshStore(store);
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().appendUserMessage(id, 'q');
    flushChatPersistence();

    const written = store.get(KEY) ?? '';
    expect(written).toContain('FRESH-DIGEST');
    expect(written).toContain('FRESH-JOB');
    expect(written).not.toContain('STALE-DIGEST');
    expect(written).not.toContain('STALE-JOB');
  });
});
