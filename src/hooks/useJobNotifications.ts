/**
 * Tell a chemist who is not looking at the tab that their job finished.
 *
 * Two channels: the title badge (always works, no permission) and a desktop notification (needs
 * permission). This hook never calls `requestPermission()`: an unprompted dialog risks a permanent
 * `denied`, so the request happens on an explicit opt-in click (sidebar footer). Here we only read
 * `Notification.permission`.
 */

import { useEffect, useRef } from 'react';
import { useChatStore } from '../state/chatStore.ts';

const BASE_TITLE = 'Chemclaw — process & analytical development assistant';

export function useJobNotifications(): void {
  const jobFeed = useChatStore((s) => s.jobFeed);
  const notifyEnabled = useChatStore((s) => s.notifyOnJobComplete);
  const announced = useRef(new Set<string>());

  /**
   * When this page started caring: feed items older than this are backlog, not news, and do not
   * notify (a background-restored tab would otherwise fire one per persisted unseen job). The
   * backlog still shows in `document.title`. Set in the effect below, since `Date.now()` in render
   * is impure.
   */
  const startedAt = useRef<number | null>(null);

  const unseen = jobFeed.filter((j) => !j.seen && !j.dismissed);

  // The one place that writes document.title. Keep it that way, or two writers will fight.
  useEffect(() => {
    document.title =
      unseen.length > 0 ? `(${unseen.length > 9 ? '9+' : unseen.length}) Chemclaw` : BASE_TITLE;
    return () => {
      document.title = BASE_TITLE;
    };
  }, [unseen.length]);

  // Mark seen when the tab actually comes back, not on focus alone: alt-tabbing past a window
  // should not silently clear a count the reader never looked at.
  useEffect(() => {
    const onVisible = (): void => {
      if (!document.hidden) useChatStore.getState().markJobsSeen();
    };
    onVisible();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    // Set before every guard and only on the first commit (`??=`): the effect re-runs every render,
    // and a moving watermark would skip a completion already received.
    startedAt.current ??= Date.now();
    if (!notifyEnabled) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    // Only when they cannot already see it. A notification for a visible tab is noise.
    if (!document.hidden) return;

    for (const item of unseen) {
      // `receivedAt` is when THIS client took delivery, so the comparison is against one clock.
      if (item.receivedAt < (startedAt.current ?? 0)) continue;
      if (announced.current.has(item.event.job_id)) continue;
      announced.current.add(item.event.job_id);
      try {
        const notification = new Notification('Background job finished', {
          body: item.event.job_id,
          // Re-delivery replaces rather than stacks.
          tag: item.event.job_id,
        });
        notification.onclick = () => {
          window.focus();
          // Deep link straight to the conversation that launched it — the router's payoff. A
          // full navigation rather than history.pushState: the click may arrive with the tab
          // backgrounded, where React's router is not listening for us.
          if (item.conversationId) window.location.assign(`/c/${item.conversationId}`);
          notification.close();
        };
      } catch {
        // Some engines throw on constructing a Notification outside a service worker. The title
        // badge is still doing its job, so this is not worth surfacing.
      }
    }
  }, [unseen, notifyEnabled]);
}
