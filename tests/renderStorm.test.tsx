/**
 * The shell stays off the per-token render path.
 *
 * `updateAssistant` replaces `state.conversations` on every animation-frame token flush — that is
 * the design, and `MessageList.tsx` documents the consequence: *"a parent that selects the whole
 * object re-renders at the same rate and drags its siblings — the header, the job feed, the
 * composer — with it."* The transcript took that advice. Three call sites above it did not, and
 * each read `s.conversations` whole: `SidebarBody` (for an ordered id list), `useJobStreams` (for a
 * watch key — and its component is `AppShell`, so this one re-rendered the top bar, the composer
 * and the entity rail too), and `JobFeed` (for one title string per card).
 *
 * zustand v5 has no implicit shallow compare, so each of those three subscriptions changed
 * identity ~60×/s for the whole of every answer. Measured before the fix, on the sidebar alone:
 * 2.8 ms per flush at one conversation and 50.5 ms at thirty — linear in a number the chemist
 * grows over time — and with `useJobStreams` stubbed out, twenty token flushes went from twenty
 * renders each of Sidebar/TopBar/Composer/EntityRail to zero.
 *
 * This file pins the property that fix rests on, at the level it actually holds: a token flush
 * must not change what any of the three projections *returns*. That is what makes zustand skip the
 * re-render, and unlike a render count it does not depend on how a test happens to mount the tree.
 * A future selector that widens back to the whole map fails here.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore } from '../src/state/chatStore.ts';
import { visibleConversationIds } from '../src/components/Sidebar.tsx';
import { watchedSessionKey } from '../src/hooks/useJobStreams.ts';

const reset = (): void => {
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

/** A conversation mid-answer, plus a few settled ones beside it. */
function seed(others = 4): { cid: string; mid: string } {
  for (let i = 0; i < others; i += 1) {
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().appendUserMessage(id, `an earlier question ${i}`);
    useChatStore.getState().setSessionId(id, `s${i}`.padEnd(32, '0'));
  }
  const cid = useChatStore.getState().createConversation();
  useChatStore.getState().appendUserMessage(cid, 'the live question');
  useChatStore.getState().setSessionId(cid, 'live'.padEnd(32, '0'));
  const mid = useChatStore.getState().startAssistantMessage(cid);
  return { cid, mid };
}

beforeEach(reset);

describe('a token flush', () => {
  it('does not change the sidebar’s list of conversation ids', () => {
    const { cid, mid } = seed();
    const before = visibleConversationIds(useChatStore.getState(), '');

    useChatStore.getState().appendTokens(cid, mid, 'The p');
    const during = visibleConversationIds(useChatStore.getState(), '');
    useChatStore.getState().appendTokens(cid, mid, 'Ka is ');

    // Shallow-equal, which is what `useShallow` compares — the array is newly built each time and
    // that is fine; what must not change is its contents.
    expect(during).toEqual(before);
    expect(visibleConversationIds(useChatStore.getState(), '')).toEqual(before);
  });

  it('does not change the sidebar’s list while a search is active', () => {
    // The search path is the expensive one: it reads every message body in every conversation.
    const { cid, mid } = seed();
    const before = visibleConversationIds(useChatStore.getState(), 'earlier');

    useChatStore.getState().appendTokens(cid, mid, 'more text that does not match');

    expect(visibleConversationIds(useChatStore.getState(), 'earlier')).toEqual(before);
  });

  it('lets a streamed answer become findable once it says the word', () => {
    // The complement of the test above, and the reason the cache is keyed on the conversation
    // object rather than on its id: a cache that never invalidated would make the search blind to
    // everything said after the conversation was first scanned.
    const { cid, mid } = seed();
    expect(visibleConversationIds(useChatStore.getState(), 'palladacycle')).toEqual([]);

    useChatStore.getState().appendTokens(cid, mid, 'Use the palladacycle precatalyst.');

    expect(visibleConversationIds(useChatStore.getState(), 'palladacycle')).toEqual([cid]);
  });

  it('does not change the set of sessions the job stream watches', () => {
    // The projection rather than the hook: the hook opens sockets, and what is being pinned is
    // that the key its effect is keyed on — and, since `AppShell` is the component that calls it,
    // the key the whole shell's render rate depends on — holds still through a flush.
    const { cid, mid } = seed();
    const before = watchedSessionKey(useChatStore.getState());
    expect(before).not.toBe('');

    useChatStore.getState().appendTokens(cid, mid, 'tokens');

    expect(watchedSessionKey(useChatStore.getState())).toBe(before);
  });

  it('does not change the titles the job feed reads', () => {
    const { cid, mid } = seed();
    const titles = (): Record<string, string> =>
      Object.fromEntries(
        Object.entries(useChatStore.getState().conversations).map(([id, c]) => [id, c.title]),
      );
    const { result, rerender } = renderHook(() =>
      useChatStore(
        useShallow((s) =>
          Object.fromEntries(Object.entries(s.conversations).map(([id, c]) => [id, c.title])),
        ),
      ),
    );
    const before = result.current;

    useChatStore.getState().appendTokens(cid, mid, 'tokens that are not a title');
    rerender();

    // Identity, not equality: `useShallow` must have handed back the *same* object, which is what
    // stops React re-rendering the feed and every card in it.
    expect(result.current).toBe(before);
    expect(titles()).toEqual(before);
  });
});
