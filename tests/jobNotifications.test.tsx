/**
 * A backlog is not news.
 *
 * `jobFeed` is persisted and kept for seven days; `markJobsSeen` runs from the `visibilitychange`
 * effect and deliberately early-returns while `document.hidden`, so "unseen" accumulates exactly
 * as designed; and `announced` is a fresh `Set` on every mount. Each of those three is right on
 * its own, and together they made a tab restored **in the background** announce its whole history
 * at once.
 *
 * Measured before the fix: 12 persisted-unseen items aged six days constructed **12** OS
 * notifications on mount — stacked rather than collapsed, because the `tag` is per `job_id`, so
 * the reader gets twelve separate claims that something just finished. Afterwards: **0**, with
 * `document.title` still reading `(9+) Chemclaw`, which is the channel that can honestly say
 * "there are things here" without dating any of them.
 *
 * The rule is a watermark on `receivedAt` — when THIS client took delivery — rather than an age
 * cutoff, because the question is not how old the job is but whether the page was there when it
 * landed. Both are measured here: the six-day backlog is silent, and a completion arriving after
 * the mount still rings.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useChatStore } from '../src/state/chatStore.ts';
import { useJobNotifications } from '../src/hooks/useJobNotifications.ts';
import type { JobFeedItem } from '../src/state/chatStore.ts';

const SID = 'a'.repeat(32);
const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1_000;

/** Every notification the hook constructed, in order. */
let constructed: { body: string; tag: string }[] = [];

/** happy-dom has no Notification, which is also how iOS Safari looks — so it is installed here
 *  rather than patched, and the permission is `granted` because a denied one tests nothing. */
class FakeNotification {
  static permission: NotificationPermission = 'granted';
  onclick: (() => void) | null = null;
  constructor(_title: string, options: { body: string; tag: string }) {
    constructed.push(options);
  }
  close(): void {}
}

const backlog = (count: number, age: number): JobFeedItem[] =>
  Array.from({ length: count }, (_, i) => ({
    event: { type: 'job_completed', job_id: `job-${i}`, summary: { converged: true } },
    sessionId: SID,
    conversationId: null,
    receivedAt: Date.now() - age,
    seen: false,
    dismissed: false,
  }));

/** The tab is in the background, which is the only state that notifies at all — and the state in
 *  which `markJobsSeen` will not clear the backlog. */
const hide = (hidden: boolean): void => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
};

beforeEach(() => {
  constructed = [];
  (globalThis as Record<string, unknown>).Notification = FakeNotification;
  hide(true);
  useChatStore.setState({ jobFeed: [], notifyOnJobComplete: true });
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).Notification;
  hide(false);
});

describe('a tab restored in the background', () => {
  it('does not announce a week of persisted completions on mount', () => {
    useChatStore.setState({ jobFeed: backlog(12, SIX_DAYS_MS) });

    const { unmount } = renderHook(() => useJobNotifications());

    expect(constructed).toHaveLength(0);
    // The count is not lost — it is carried by the channel that never claims novelty.
    expect(document.title).toBe('(9+) Chemclaw');
    unmount();
  });

  it('still rings for a job that finishes while it is open', () => {
    useChatStore.setState({ jobFeed: backlog(3, SIX_DAYS_MS) });

    const { unmount } = renderHook(() => useJobNotifications());
    expect(constructed).toHaveLength(0);

    act(() => {
      useChatStore
        .getState()
        .pushJobFinished(
          { type: 'job_completed', job_id: 'fresh', summary: { converged: true } },
          SID,
        );
    });

    expect(constructed.map((n) => n.tag)).toEqual(['fresh']);
    unmount();
  });
});
