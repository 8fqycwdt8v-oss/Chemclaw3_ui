/**
 * Does this device believe it has a network at all?
 *
 * Every failure in this app currently reads as a service problem. The backoff in `useJobStreams`
 * and the detach-recovery in the turn path both handle *a request that failed*, and neither can
 * tell a chemist on a shared bench tablet behind a flaky AP that the reason is their own Wi-Fi.
 * On that hardware it is the most common failure in the product, and it is the one the browser
 * can answer for free — `navigator.onLine` and the `online`/`offline` events appear nowhere in
 * `src/`.
 *
 * **What it knows, exactly.** `navigator.onLine` is a link-layer signal: false means the browser
 * has no usable network interface, and it is trustworthy in that direction — nothing can reach
 * the service, so a failure is not evidence about the service. True means only that an interface
 * exists. A captive portal, a Wi-Fi with no route out, a DNS server that stopped answering and a
 * dead backend all read as online. So this hook is named, and used, for the half it can prove:
 * it reports **offline**, never "connected". The service-health probe in `TopBar` is what
 * answers reachability, and it stays the only thing that claims to.
 *
 * `useSyncExternalStore` rather than `useState` + an effect: the value is external state that can
 * change between render and commit, and this is the one API that cannot tear. The server
 * snapshot is `false` — a document rendered without a browser has no link to report on, and
 * announcing "offline" during hydration would be a lie about the one thing this hook exists to
 * be honest about.
 */

import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** `navigator.onLine` is optional in the DOM lib on some hosts; an absent one is not "offline". */
const snapshot = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

export function useOffline(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
