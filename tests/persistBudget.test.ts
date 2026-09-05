/**
 * What the persisted slice costs, and what it does when it does not fit.
 *
 * `tests/persistQuota.test.ts` already proves that a refused write does not break Send and that one
 * conversation's transcript is bounded. This file is about the three things that survived it,
 * because each one is invisible from a green suite and each loses a chemist's history:
 *
 *  - **the shed could write nothing and call it a success.** With one conversation left,
 *    `Math.floor(1 / 2)` is `0`, so `shedOldest` returned `order: []` — which is not `null`, so it
 *    was written and returned from. Measured: two refusals, one write, zero conversations
 *    persisted, `storageWritable` still `true`, so the "history could not be saved" warning never
 *    fired either.
 *  - **the shed was forgotten the moment it worked**, so the next flush 750 ms later re-did all of
 *    it. Measured at the caps' ceiling: 37.5 ms of blocking work and 12.3 MiB stringified per
 *    flush, ten refusals, for the life of the tab — while an answer is streaming.
 *  - **a settled answer went to disk twice**, `finalText` and an identical `streamedText`.
 *    Measured 2.09x on one 10,800-character answer, which is half the effective history budget and
 *    the largest single contributor to reaching the cliff at all.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerEvent } from './helpers.ts';

const KEY = 'chemclaw3.chat.v2.anon';

/**
 * A store module of this test's own.
 *
 * `storageWritable` and the learned conversation cap are module scope — deliberately, they are
 * facts about the browser this page is running in — so a test that latches one poisons every test
 * after it in the same file. Resetting the module registry per test is the only isolation
 * available, and it means each test must drive the store it imported rather than a file-level one.
 */
async function freshStore() {
  vi.resetModules();
  return await import('../src/state/chatStore.ts');
}

/** A `localStorage` with a real budget, refusing the way a browser does. */
function budgeted(bytes: number) {
  const store = new Map<string, string>();
  const refusals: number[] = [];
  return {
    store,
    refusals,
    fake: {
      length: 0,
      key: () => null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (v.length > bytes) {
          refusals.push(v.length);
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        }
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a payload that will not fit', () => {
  it('never persists an empty slice and calls it saved', async () => {
    const { useChatStore, flushChatPersistence } = await freshStore();
    // One conversation, far over budget on its own — the case stage one has nothing to drop.
    const { fake, store } = budgeted(4_000);
    vi.stubGlobal('localStorage', fake);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const id = useChatStore.getState().createConversation();
    for (let i = 0; i < 40; i += 1) {
      useChatStore.getState().appendUserMessage(id, 'x'.repeat(1_000));
    }
    flushChatPersistence();

    const written = store.get(KEY);
    if (written) {
      // Whatever landed must still be the conversation, not an empty husk in its place.
      expect(written).toContain(id);
      expect(written).not.toContain('"conversations":{}');
    } else {
      // Or nothing landed — which is the honest outcome, and it has to say so rather than
      // reporting success on an empty write.
      expect(warn).toHaveBeenCalled();
    }
  });

  it('keeps the newest half of a single over-budget conversation rather than none of it', async () => {
    const { useChatStore, flushChatPersistence } = await freshStore();
    const { fake, store } = budgeted(30_000);
    vi.stubGlobal('localStorage', fake);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const id = useChatStore.getState().createConversation();
    for (let i = 0; i < 30; i += 1) {
      useChatStore.getState().appendUserMessage(id, `${'x'.repeat(1_000)} message-${i}`);
    }
    flushChatPersistence();

    const written = store.get(KEY) ?? '';
    // The end of the conversation is what a chemist comes back for.
    expect(written).toContain('message-29');
    expect(written).not.toContain('message-0 ');
  });

  it('stops re-shedding on every flush once it has learned what fits', async () => {
    const { useChatStore, flushChatPersistence } = await freshStore();
    // The convergence property. Without it each flush repeats the whole refuse-shed-restringify
    // cycle, which is 37.5 ms of blocked main thread every 750 ms, for ever.
    const { fake, refusals } = budgeted(12_000);
    vi.stubGlobal('localStorage', fake);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    for (let i = 0; i < 8; i += 1) {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().appendUserMessage(id, `${'x'.repeat(1_500)} ${i}`);
    }
    flushChatPersistence();
    const afterFirst = refusals.length;
    expect(afterFirst).toBeGreaterThan(0);

    // Three more flushes of the same over-sized state.
    for (let i = 0; i < 3; i += 1) {
      useChatStore.getState().selectConversation(useChatStore.getState().order[0] as string);
      flushChatPersistence();
    }

    // At most one further refusal per flush would be the old behaviour; converged means none.
    expect(refusals.length).toBe(afterFirst);
  });
});

describe('the persisted payload', () => {
  it('writes a settled answer once, not twice', async () => {
    const { useChatStore, flushChatPersistence } = await freshStore();
    const { fake, store } = budgeted(5_000_000);
    vi.stubGlobal('localStorage', fake);

    const id = useChatStore.getState().createConversation();
    useChatStore.getState().appendUserMessage(id, 'what is the pKa');
    const mid = useChatStore.getState().startAssistantMessage(id);
    const answer = 'The pKa is 4.76 in water at 25 °C. '.repeat(300);
    useChatStore.getState().applyEvent(id, mid, { type: 'token', text: answer });
    useChatStore.getState().applyEvent(id, mid, answerEvent({ text: answer }));
    flushChatPersistence();

    const written = store.get(KEY) ?? '';
    const occurrences = written.split('The pKa is 4.76').length - 1;
    // Once for `finalText`. `streamedText` held a byte-identical copy that no reader consults
    // while `finalText` is set — measured at 2.09x the payload for one answer.
    expect(occurrences).toBe(300);
  });

  it('keeps the streamed text when it is the only copy there is', async () => {
    const { useChatStore, flushChatPersistence } = await freshStore();
    // The complement, and the reason the condition is `finalText` being non-empty rather than the
    // message being settled: an aborted turn's partial answer is the answer.
    const { fake, store } = budgeted(5_000_000);
    vi.stubGlobal('localStorage', fake);

    const id = useChatStore.getState().createConversation();
    useChatStore.getState().appendUserMessage(id, 'q');
    const mid = useChatStore.getState().startAssistantMessage(id);
    useChatStore.getState().applyEvent(id, mid, { type: 'token', text: 'a partial answer' });
    useChatStore.getState().finishTurn(id, mid, 'aborted');
    flushChatPersistence();

    expect(store.get(KEY) ?? '').toContain('a partial answer');
  });

  it('carries the draft the chemist was half-way through typing', async () => {
    const { useChatStore, flushChatPersistence } = await freshStore();
    const { fake, store } = budgeted(5_000_000);
    vi.stubGlobal('localStorage', fake);

    const id = useChatStore.getState().createConversation();
    useChatStore.getState().appendUserMessage(id, 'q');
    useChatStore.getState().setDraft(id, 'and what about the 2-MeTHF case');
    flushChatPersistence();

    expect(store.get(KEY) ?? '').toContain('and what about the 2-MeTHF case');
  });
});

describe('two tabs on one account', () => {
  it('does not erase a conversation the other tab wrote', async () => {
    const { useChatStore, flushChatPersistence } = await freshStore();
    // Both tabs resolve to the same key, read it once at boot, and then write their whole map
    // every 750 ms. Before this, the later writer's map simply replaced the earlier one's, and a
    // conversation started in the other tab was gone on the next reload.
    const { fake, store } = budgeted(5_000_000);
    vi.stubGlobal('localStorage', fake);

    // What the other tab left on disk.
    store.set(
      KEY,
      JSON.stringify({
        version: 3,
        state: {
          conversations: {
            'other-tab': {
              id: 'other-tab',
              sessionId: '',
              title: 'started in the other window',
              messages: [],
              trace: [],
              createdAt: 1,
              updatedAt: 1,
              sessionOrigin: 'local',
            },
          },
          order: ['other-tab'],
          activeId: 'other-tab',
          drafts: {},
          jobFeed: [],
          notifyOnJobComplete: false,
        },
      }),
    );

    const mine = useChatStore.getState().createConversation();
    useChatStore.getState().appendUserMessage(mine, 'my question');
    flushChatPersistence();

    const written = store.get(KEY) ?? '';
    expect(written).toContain('started in the other window');
    expect(written).toContain('my question');
  });

  it('does not resurrect a conversation this tab deleted', async () => {
    const { useChatStore, flushChatPersistence } = await freshStore();
    // The merge's one hard edge: without a tombstone, "delete" would mean "delete until the other
    // tab flushes".
    const { fake, store } = budgeted(5_000_000);
    vi.stubGlobal('localStorage', fake);

    const doomed = useChatStore.getState().createConversation();
    useChatStore.getState().appendUserMessage(doomed, 'delete me');
    flushChatPersistence();
    expect(store.get(KEY) ?? '').toContain('delete me');

    useChatStore.getState().deleteConversation(doomed);
    const keeper = useChatStore.getState().createConversation();
    useChatStore.getState().appendUserMessage(keeper, 'keep me');
    flushChatPersistence();

    const written = store.get(KEY) ?? '';
    expect(written).toContain('keep me');
    expect(written).not.toContain('delete me');
  });
});

describe('persisted state from a version this build has never seen', () => {
  it('is discarded rather than passed through into a renderer', async () => {
    // zustand calls `migrate` whenever the version *differs*, newer included, and every step is
    // guarded `if (version < n)` — so a v4 slice used to be returned unchanged and cast. A canary
    // or a rollback produces exactly this, and `useJobNotifications` then does `.filter` on
    // whatever `jobFeed` turned out to be, which throws during the render of the whole shell.
    const { migratePersisted } = await freshStore();

    const fromTheFuture = migratePersisted(
      { conversations: {}, order: [], activeId: null, jobFeed: 'not an array' },
      4,
    );

    expect(Array.isArray(fromTheFuture.jobFeed)).toBe(true);
    expect(fromTheFuture.conversations).toEqual({});
  });

  it('survives a migration step that throws on a shape it did not expect', async () => {
    // `migrateV1toV2` does `(state.order ?? []).filter(...)`, which throws outright on a non-array
    // `order` — and reached `persist.rehydrate()` as an unhandled rejection, which no caller
    // awaits.
    const { migratePersisted } = await freshStore();

    expect(() =>
      migratePersisted({ conversations: { a: null }, order: 'not an array' }, 1),
    ).not.toThrow();
  });
});
