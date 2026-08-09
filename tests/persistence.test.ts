/**
 * The persistence path, which had no test at all.
 *
 * This is the code a previous fix (`d7e85d8`, "abandon old persisted state") was written to
 * repair, and nothing pinned it afterwards — so the repair itself was wrong in a way nobody could
 * see: it renamed the storage key instead of migrating, which orphaned the old blob rather than
 * clearing it. It stayed on disk, counted against the same origin quota, and survived "Reset app".
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPersisted, useChatStore, STORAGE_KEY, LEGACY_KEYS } from '../src/state/chatStore.ts';

const reset = (): void => {
  localStorage.clear();
  useChatStore.setState({
    conversations: {},
    order: [],
    activeId: null,
    composerLock: false,
    banner: null,
    jobFeed: [],
    streaming: null,
  });
};

beforeEach(reset);
afterEach(reset);

describe('clearPersisted', () => {
  it('removes the legacy keys, not just the current one', () => {
    localStorage.setItem(STORAGE_KEY, '{"state":{}}');
    for (const key of LEGACY_KEYS) localStorage.setItem(key, '{"state":{}}');

    clearPersisted();

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    for (const key of LEGACY_KEYS) {
      // The whole point: a reset that visibly clears your work while leaving megabytes of
      // transcripts on disk is the wrong answer twice over for a GxP-adjacent tool.
      expect(localStorage.getItem(key)).toBeNull();
    }
  });

  it('is called by clearAll, so "Reset app" really clears storage', () => {
    localStorage.setItem(LEGACY_KEYS[0], '{"state":{"conversations":{}}}');
    useChatStore.getState().clearAll();
    expect(localStorage.getItem(LEGACY_KEYS[0])).toBeNull();
  });
});

describe('clearAll and deleteConversation', () => {
  it('aborts an in-flight turn instead of orphaning its controller', () => {
    // Setting `streaming: null` and walking away left the fetch running: it kept spending the turn
    // budget, kept the session's turn lock held, and `stopStreaming` could no longer reach it.
    const controller = new AbortController();
    const cid = useChatStore.getState().createConversation();
    useChatStore.getState().setStreaming({
      conversationId: cid,
      messageId: 'm1',
      abort: controller,
    });

    useChatStore.getState().clearAll();

    expect(controller.signal.aborted).toBe(true);
    expect(useChatStore.getState().streaming).toBeNull();
  });

  it('aborts when the conversation being deleted is the streaming one', () => {
    const controller = new AbortController();
    const cid = useChatStore.getState().createConversation();
    useChatStore
      .getState()
      .setStreaming({ conversationId: cid, messageId: 'm1', abort: controller });

    useChatStore.getState().deleteConversation(cid);
    expect(controller.signal.aborted).toBe(true);
  });

  it('leaves another conversation’s turn alone', () => {
    const controller = new AbortController();
    const streamingId = useChatStore.getState().createConversation();
    const otherId = useChatStore.getState().createConversation();
    useChatStore
      .getState()
      .setStreaming({ conversationId: streamingId, messageId: 'm1', abort: controller });

    useChatStore.getState().deleteConversation(otherId);
    expect(controller.signal.aborted).toBe(false);
  });
});

describe('the conversation cap', () => {
  it('is enforced in memory, not only when persisting', () => {
    // It used to live solely in `partialize`, so conversation 31 appeared in the sidebar, could be
    // worked in, and then vanished on reload with no warning at any point.
    for (let i = 0; i < 35; i += 1) useChatStore.getState().createConversation();
    expect(useChatStore.getState().order.length).toBeLessThanOrEqual(30);
  });
});

describe('composer lock scoping', () => {
  it('keeps a terminal budget lock across navigation', () => {
    const a = useChatStore.getState().createConversation();
    useChatStore.getState().createConversation();
    useChatStore.getState().setComposerLock('budget_exhausted');

    useChatStore.getState().selectConversation(a);
    // The budget is per-session AND per-user, so switching conversations does not restore it.
    expect(useChatStore.getState().composerLock).toBe('budget_exhausted');
  });

  it('clears an in-flight lock, which belongs to the conversation being left', () => {
    const a = useChatStore.getState().createConversation();
    useChatStore.getState().createConversation();
    useChatStore.getState().setComposerLock('turn_in_flight');

    useChatStore.getState().selectConversation(a);
    expect(useChatStore.getState().composerLock).toBe(false);
  });
});
