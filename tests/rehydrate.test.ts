/**
 * What happens to a blob that is already on disk when this build loads it.
 *
 * These are the assertions whose absence let two regressions ship. `tests/persistence.test.ts`
 * exercised `clearPersisted` and the raw store actions, but never round-tripped through the persist
 * middleware — so nothing pinned the storage key, and nothing pinned that a message left marked
 * `streaming` by a reload is retired on load. Both broke, and both broke silently.
 *
 * Everything here goes through `useChatStore.persist.rehydrate()`, i.e. the real middleware, rather
 * than calling the migration helpers directly. Testing the helper would have passed against the
 * broken build too: the helper was correct, it simply was never reached.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_KEYS, STORAGE_KEY, useChatStore } from '../src/state/chatStore.ts';

/** A stored blob in zustand's persist envelope. */
const seed = (key: string, state: unknown, version?: number): void => {
  localStorage.setItem(key, JSON.stringify(version === undefined ? { state } : { state, version }));
};

const conversation = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'c1',
  sessionId: 'a'.repeat(32),
  title: 'Suzuki coupling yield',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  contextLost: false,
  messages: [
    { id: 'm1', role: 'user', text: 'What was the yield?', at: 1_700_000_000_000 },
    {
      id: 'm2',
      role: 'assistant',
      at: 1_700_000_000_001,
      status: 'done',
      streamedText: '',
      finalText: '72%.',
      confidence: null,
      unsupportedClaims: [],
      reviewRequired: false,
      degradedConnectors: [],
      queued: false,
      trace: [],
      latestPlan: null,
      error: null,
    },
  ],
  ...over,
});

const reset = (): void => {
  // State first, storage second. The persist middleware writes on every `setState`, so clearing
  // storage before resetting the store leaves an empty blob under the live key — which then wins
  // over the legacy blob these tests are about, and the adoption path never runs. In a real load
  // nothing has written yet at that point.
  useChatStore.setState({
    conversations: {},
    order: [],
    activeId: null,
    composerLock: false,
    banner: null,
    jobFeed: [],
    streaming: null,
  });
  localStorage.clear();
};

beforeEach(reset);
afterEach(reset);

describe('an existing user’s history', () => {
  it('survives loading this build', async () => {
    // The regression: the storage key was renamed, and zustand's `hydrate()` reads
    // `storage.getItem(options.name)` — only the current name. Every conversation a user had was
    // orphaned under the old key, invisible to the app and still counting against the quota.
    seed(
      LEGACY_KEYS[1],
      { conversations: { c1: conversation() }, order: ['c1'], activeId: 'c1' },
      1,
    );

    await useChatStore.persist.rehydrate();

    const state = useChatStore.getState();
    expect(state.order).toContain('c1');
    expect(state.conversations.c1?.title).toBe('Suzuki coupling yield');
    expect(state.conversations.c1?.messages).toHaveLength(2);
  });

  it('is carried forward, not left behind under the old key', async () => {
    seed(
      LEGACY_KEYS[0],
      { conversations: { c1: conversation() }, order: ['c1'], activeId: 'c1' },
      1,
    );

    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().order).toContain('c1');
    // Migrated means moved: leaving the old blob in place is what filled the quota last time.
    expect(localStorage.getItem(LEGACY_KEYS[0])).toBeNull();
  });

  it('prefers the live key when both exist', async () => {
    seed(
      LEGACY_KEYS[1],
      { conversations: { c1: conversation({ title: 'stale' }) }, order: ['c1'] },
      1,
    );
    seed(
      STORAGE_KEY,
      { conversations: { c1: conversation({ title: 'current' }) }, order: ['c1'] },
      2,
    );

    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().conversations.c1?.title).toBe('current');
  });
});

describe('a turn interrupted by a reload', () => {
  it('loads as aborted, not as still streaming', async () => {
    // There is no resume endpoint, so a message rehydrated as `streaming` renders a blinking caret
    // forever. The demotion was moved into `migrate`, which zustand only calls on a version
    // MISMATCH — so at steady state it ran on no loads at all.
    seed(
      STORAGE_KEY,
      {
        conversations: {
          c1: conversation({
            messages: [
              {
                id: 'm1',
                role: 'assistant',
                at: 1,
                status: 'streaming',
                streamedText: 'The pKa is',
                finalText: null,
                confidence: null,
                unsupportedClaims: [],
                reviewRequired: false,
                degradedConnectors: [],
                queued: false,
                trace: [],
                latestPlan: null,
                error: null,
              },
            ],
          }),
        },
        order: ['c1'],
        activeId: 'c1',
      },
      2, // the CURRENT version — this is the path that must work
    );

    await useChatStore.persist.rehydrate();

    const message = useChatStore.getState().conversations.c1?.messages[0];
    expect(message?.role).toBe('assistant');
    expect(message && message.role === 'assistant' && message.status).toBe('aborted');
    expect(message && message.role === 'assistant' && message.error?.message).toMatch(/reload/i);
  });

  it('keeps the partial text, which is the only copy of it', async () => {
    seed(
      STORAGE_KEY,
      {
        conversations: {
          c1: conversation({
            messages: [
              {
                id: 'm1',
                role: 'assistant',
                at: 1,
                status: 'streaming',
                streamedText: 'The pKa is 4.7',
                finalText: null,
                confidence: null,
                unsupportedClaims: [],
                reviewRequired: false,
                degradedConnectors: [],
                queued: false,
                trace: [],
                latestPlan: null,
                error: null,
              },
            ],
          }),
        },
        order: ['c1'],
      },
      2,
    );

    await useChatStore.persist.rehydrate();
    const message = useChatStore.getState().conversations.c1?.messages[0];
    expect(message && message.role === 'assistant' && message.streamedText).toBe('The pKa is 4.7');
  });
});

describe('a corrupt blob', () => {
  it('does not take the app down with it', async () => {
    // The crash-loop breaker's whole story depends on a bad blob being survivable.
    seed(
      STORAGE_KEY,
      { conversations: { c1: { id: 'c1', messages: 'not an array' } }, order: ['c1', 'ghost'] },
      2,
    );

    await expect(useChatStore.persist.rehydrate()).resolves.not.toThrow();
    // `ghost` names no conversation, so it must not survive in `order`.
    expect(useChatStore.getState().order).not.toContain('ghost');
  });

  it('drops a message whose shape is unusable rather than rendering it', async () => {
    seed(
      STORAGE_KEY,
      {
        conversations: { c1: conversation({ messages: [{ role: 'assistant' }, null, 'nope'] }) },
        order: ['c1'],
      },
      2,
    );

    await useChatStore.persist.rehydrate();
    expect(useChatStore.getState().conversations.c1?.messages).toHaveLength(0);
  });
});

describe('clearAll', () => {
  it('actually leaves nothing behind on disk', async () => {
    seed(STORAGE_KEY, { conversations: { c1: conversation() }, order: ['c1'] }, 2);
    await useChatStore.persist.rehydrate();

    useChatStore.getState().clearAll();

    // The persist middleware writes on every `set`, so removing the key and then mutating state
    // put it straight back. Whatever remains must be an empty slate, not the old transcripts.
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) expect(raw).not.toContain('Suzuki coupling yield');
    for (const key of LEGACY_KEYS) expect(localStorage.getItem(key)).toBeNull();
  });
});
