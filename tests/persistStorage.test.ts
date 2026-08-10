/**
 * The persist adapter's two jobs: coalescing writes, and surviving a full disk.
 *
 * `persist` calls `setItem` synchronously on every `set()`, and the store's `partialize`
 * serialises every message of every kept conversation each time. `appendTokens` fires once per
 * animation frame for a whole answer and `setDraft` fires per keystroke — and `drafts` is not in
 * the persisted slice, so those writes produce a byte-identical blob at full transcript cost.
 *
 * The quota half is the one that bit hardest: nothing caught a throwing `setItem`, so the throw
 * escaped through whatever action happened to trigger it. On the send path that is before the
 * turn starts, so the composer never locked and no message was sent, silently.
 *
 * Each test imports the module fresh. The write queue is module-level state by design — there is
 * one localStorage — so sharing it across tests leaks a pending write and a timer handle from the
 * fake clock of whichever test queued it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'chemclaw3.chat.v2';

const quotaError = (): DOMException => new DOMException('full', 'QuotaExceededError');

/** A fresh adapter bound to a stub store, so nothing is shared between tests. */
async function freshAdapter(setItem: (key: string, value: string) => void) {
  vi.resetModules();
  const backing = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem,
    removeItem: (k: string) => backing.delete(k),
    clear: () => backing.clear(),
  });
  return await import('../src/state/persistStorage.ts');
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('coalescing', () => {
  it('collapses a burst of writes into one', async () => {
    const writes: string[] = [];
    const { coalescedLocalStorage } = await freshAdapter((_k, v) => writes.push(v));

    for (let i = 0; i < 60; i++) coalescedLocalStorage.setItem(KEY, `{"n":${i}}`);
    expect(writes).toHaveLength(0);

    vi.advanceTimersByTime(300);
    expect(writes).toEqual(['{"n":59}']);
  });

  it('reads back the queued value rather than the stale one on disk', async () => {
    // Rehydration and any same-tick read must see the newest state, not what survived the last
    // flush — otherwise coalescing would be observable as lost state.
    const { coalescedLocalStorage } = await freshAdapter(() => {});
    coalescedLocalStorage.setItem(KEY, '{"n":1}');

    expect(coalescedLocalStorage.getItem(KEY)).toBe('{"n":1}');
  });

  it('flushes on demand, so a reload cannot land inside the window', async () => {
    const writes: string[] = [];
    const { coalescedLocalStorage, flushPendingWrite } = await freshAdapter((_k, v) =>
      writes.push(v),
    );

    coalescedLocalStorage.setItem(KEY, '{"n":7}');
    flushPendingWrite();

    expect(writes).toEqual(['{"n":7}']);
  });
});

describe('quota', () => {
  it('does not throw into the caller when storage is full', async () => {
    const { coalescedLocalStorage, flushPendingWrite } = await freshAdapter(() => {
      throw quotaError();
    });

    coalescedLocalStorage.setItem(KEY, '{"state":{"jobFeed":[]}}');
    expect(() => flushPendingWrite()).not.toThrow();
  });

  it('sheds the job feed and retries before giving up', async () => {
    const attempts: string[] = [];
    const { coalescedLocalStorage, flushPendingWrite } = await freshAdapter((_k, v) => {
      attempts.push(v);
      if (attempts.length === 1) throw quotaError();
    });

    coalescedLocalStorage.setItem(KEY, '{"state":{"jobFeed":[{"a":1}],"order":["c1"]}}');
    flushPendingWrite();

    expect(attempts).toHaveLength(2);
    // Conversations are the user's own history and are never shed to make room.
    expect(attempts[1]).toContain('"order":["c1"]');
    expect(attempts[1]).toContain('"jobFeed":[]');
  });

  it('reports once per episode, not on every failed write', async () => {
    // The listener raises a banner, and raising a banner is a store `set()`, which persist answers
    // with another write, which fails, which reports again. Left alone that is a self-feeding loop
    // that runs for as long as storage stays full.
    const { coalescedLocalStorage, flushPendingWrite, setQuotaListener } = await freshAdapter(
      () => {
        throw quotaError();
      },
    );
    const reported: string[] = [];
    setQuotaListener((m) => reported.push(m));

    for (let i = 0; i < 5; i++) {
      coalescedLocalStorage.setItem(KEY, '{"state":{}}');
      flushPendingWrite();
    }

    expect(reported).toHaveLength(1);
  });

  it('re-arms the report once a write succeeds again', async () => {
    let full = true;
    const { coalescedLocalStorage, flushPendingWrite, setQuotaListener } = await freshAdapter(
      () => {
        if (full) throw quotaError();
      },
    );
    const reported: string[] = [];
    setQuotaListener((m) => reported.push(m));

    coalescedLocalStorage.setItem(KEY, '{"state":{}}');
    flushPendingWrite();
    full = false;
    coalescedLocalStorage.setItem(KEY, '{"state":{}}');
    flushPendingWrite();
    full = true;
    coalescedLocalStorage.setItem(KEY, '{"state":{}}');
    flushPendingWrite();

    // A later, separate episode is worth telling the user about again.
    expect(reported).toHaveLength(2);
  });

  it('reports rather than throws when even that is not enough', async () => {
    const { coalescedLocalStorage, flushPendingWrite, setQuotaListener } = await freshAdapter(
      () => {
        throw quotaError();
      },
    );
    const reported: string[] = [];
    setQuotaListener((m) => reported.push(m));

    coalescedLocalStorage.setItem(KEY, '{"state":{"jobFeed":[{"a":1}]}}');
    flushPendingWrite();

    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatch(/out of local storage/);
  });
});
