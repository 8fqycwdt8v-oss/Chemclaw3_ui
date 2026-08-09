/**
 * Tell a chemist who is not looking at the tab that their job finished.
 *
 * The whole point of the push-back stream is work that takes minutes to days, so the completion
 * lands when the reader is elsewhere — in another tab, or another application. The in-app band and
 * its polite live region reach neither.
 *
 * Two channels, in order of how much they can be relied on:
 *
 *  - The **title badge** always works, needs no permission, and cannot be refused or forgotten.
 *  - A **notification** reaches someone who has switched applications entirely, and costs a
 *    permission prompt.
 *
 * The hard rule for the second: `requestPermission()` is never called from here. An unprompted
 * dialog at load is the fastest route to a permanent `denied` that no amount of later UI can undo,
 * so the request happens inside a click handler on an explicit opt-in (see the sidebar footer).
 * This hook only ever reads `Notification.permission`.
 */

import { useEffect, useRef } from 'react';
import { useChatStore } from '../state/chatStore.ts';

const BASE_TITLE = 'Chemclaw — process & analytical development assistant';

export function useJobNotifications(): void {
  const jobFeed = useChatStore((s) => s.jobFeed);
  const notifyEnabled = useChatStore((s) => s.notifyOnJobComplete);
  const announced = useRef(new Set<string>());

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
    if (!notifyEnabled) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    // Only when they cannot already see it. A notification for a visible tab is noise.
    if (!document.hidden) return;

    for (const item of unseen) {
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
