/**
 * Two tabs, one localStorage key.
 *
 * Every tab hydrated `chemclaw3.chat.v2` once at load and thereafter wrote its whole in-memory
 * snapshot over it, with nothing listening for anyone else's write. So a tab that had been open
 * since before another tab created a conversation destroyed it the next time it touched the
 * store — and "touched the store" includes typing, because drafts live there too. Multiple tabs
 * are an expected pattern here: `msalAuth` uses `sessionStorage` precisely so tokens are per-tab,
 * accepting a silent re-auth per tab in exchange.
 *
 * The resolution is a merge rather than a lock, because conversations are keyed by id and there
 * is therefore nothing to guess. What these pin is that the merge never loses a conversation and
 * never overwrites a newer one with an older one — in particular that a turn streaming in this
 * tab outranks another tab's stale copy, since `updatedAt` bumps on every token.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore, newConversation } from '../src/state/chatStore.ts';
import type { Conversation } from '../src/state/types.ts';

const conversationAt = (id: string, updatedAt: number, title: string): Conversation => ({
  ...newConversation(),
  id,
  updatedAt,
  title,
});

const persisted = (conversations: Conversation[]) => ({
  conversations: Object.fromEntries(conversations.map((c) => [c.id, c])),
  order: conversations.map((c) => c.id),
  activeId: conversations[0]?.id ?? null,
  jobFeed: [],
  notifyOnJobComplete: false,
});

const titles = () => {
  const s = useChatStore.getState();
  return s.order.map((id) => s.conversations[id]?.title);
};

beforeEach(() => {
  useChatStore.getState().clearAll();
});

describe('merging another tab’s write', () => {
  it('keeps conversations this tab has that the other tab never saw', () => {
    const mine = conversationAt('mine', 200, 'my conversation');
    useChatStore.setState({ conversations: { mine }, order: ['mine'], activeId: 'mine' });

    useChatStore.getState().mergeFromOtherTab(persisted([conversationAt('theirs', 100, 'theirs')]));

    expect(titles()).toContain('my conversation');
    expect(titles()).toContain('theirs');
  });

  it('adopts a conversation the other tab created', () => {
    useChatStore
      .getState()
      .mergeFromOtherTab(persisted([conversationAt('new', 500, 'from tab B')]));

    expect(titles()).toContain('from tab B');
  });

  it('does not overwrite a newer local conversation with an older remote one', () => {
    // The streaming case: `updatedAt` bumps on every token, so the tab running the turn is always
    // the newer one and must win.
    const fresh = conversationAt('c1', 900, 'streaming here');
    useChatStore.setState({ conversations: { c1: fresh }, order: ['c1'], activeId: 'c1' });

    useChatStore.getState().mergeFromOtherTab(persisted([conversationAt('c1', 100, 'stale copy')]));

    expect(useChatStore.getState().conversations.c1?.title).toBe('streaming here');
  });

  it('takes the remote copy when it is genuinely newer', () => {
    const old = conversationAt('c1', 100, 'old');
    useChatStore.setState({ conversations: { c1: old }, order: ['c1'], activeId: 'c1' });

    useChatStore.getState().mergeFromOtherTab(persisted([conversationAt('c1', 900, 'newer')]));

    expect(useChatStore.getState().conversations.c1?.title).toBe('newer');
  });

  it('leaves this tab reading what it was reading', () => {
    const mine = conversationAt('mine', 200, 'mine');
    useChatStore.setState({ conversations: { mine }, order: ['mine'], activeId: 'mine' });

    useChatStore.getState().mergeFromOtherTab(persisted([conversationAt('theirs', 900, 'theirs')]));

    // Following the other tab's selection would yank the reader out of what they are reading,
    // even though 'theirs' now sorts first.
    expect(useChatStore.getState().activeId).toBe('mine');
  });

  it('keeps order and conversations consistent', () => {
    useChatStore
      .getState()
      .mergeFromOtherTab(persisted([conversationAt('a', 300, 'a'), conversationAt('b', 100, 'b')]));

    const s = useChatStore.getState();
    for (const id of s.order) expect(s.conversations[id]).toBeTruthy();
    expect(Object.keys(s.conversations).sort()).toEqual([...s.order].sort());
  });
});

describe('the storage listener', () => {
  const write = (state: unknown, key = 'chemclaw3.chat.v2') =>
    window.dispatchEvent(
      new StorageEvent('storage', { key, newValue: JSON.stringify({ state, version: 3 }) }),
    );

  it('folds in another tab’s write when the event fires', () => {
    write(persisted([conversationAt('fromB', 400, 'written by tab B')]));

    expect(titles()).toContain('written by tab B');
  });

  it('ignores a write to a different key', () => {
    const before = titles();
    write(persisted([conversationAt('x', 400, 'not ours')]), 'chemclaw3.theme');

    expect(titles()).toEqual(before);
  });

  it('survives an unparseable write from another tab', () => {
    const before = titles();
    expect(() =>
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'chemclaw3.chat.v2', newValue: 'not json' }),
      ),
    ).not.toThrow();
    expect(titles()).toEqual(before);
  });
});

describe('the merge converges', () => {
  it('does not write back when the other tab told us nothing new', () => {
    // Tab A writes, tab B merges, B's persist write fires a storage event back at A, A merges,
    // A writes... Each tab keeps its own `activeId`, so the two snapshots never serialise
    // identically and the browser fires an event on every write. Without a no-op guard that is a
    // sustained cross-tab write storm — worse than the data loss it replaced.
    const mine = conversationAt('mine', 200, 'mine');
    useChatStore.setState({ conversations: { mine }, order: ['mine'], activeId: 'mine' });

    let writes = 0;
    const unsubscribe = useChatStore.subscribe(() => {
      writes += 1;
    });
    // Exactly what this tab already has, which is what the second round of a ping-pong looks like.
    useChatStore.getState().mergeFromOtherTab(persisted([conversationAt('mine', 200, 'mine')]));
    unsubscribe();

    expect(writes).toBe(0);
  });
});
