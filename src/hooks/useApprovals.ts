/**
 * The caller's open approval holds, polled.
 *
 * A durable Yes/No hold (backend D-032) authorizes a knowledge write and it *expires*. Until now
 * the only way to answer one was the card rendered inside the turn that raised it, which meant a
 * hold outlived its answer whenever the chemist closed the tab, switched conversations, or simply
 * scrolled on — and an unanswered hold times out, silently dropping the knowledge it was holding.
 * `GET /approvals` is the service's answer to exactly that, and this is the client half of it.
 *
 * Polled rather than streamed, because there is no event stream for holds: the listing is a
 * Temporal visibility query over running workflows. That query is not free, so the cadence is
 * deliberately slow and the tab pauses it while hidden — the same shape as the health poll in
 * `TopBar`. A focus or a visibility change catches up immediately, which is what makes the slow
 * interval tolerable: the moment a chemist looks at the tab, the count is fresh.
 *
 * `status` distinguishes "no holds" from "we could not ask", and the inbox renders the two
 * differently. For a queue of unsigned approvals that difference is the whole point — a queue that
 * reads empty because the query failed is worse than one that admits it is blind.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, type PendingApproval } from '../api/client.ts';
import { useAuth } from '../auth/AuthContext.tsx';

/** Slow on purpose: see the module docstring. Focus is the real freshness signal. */
const POLL_MS = 60_000;

export interface Approvals {
  holds: PendingApproval[];
  /** `loading` only before the first answer; afterwards it is one of the other two. */
  status: 'loading' | 'ok' | 'unavailable';
  refresh: () => void;
  /** Drop a hold from the list once its decision has been delivered, without waiting a poll. */
  resolve: (approvalId: string) => void;
}

export function useApprovals(): Approvals {
  const { auth, ready } = useAuth();
  const [holds, setHolds] = useState<PendingApproval[]>([]);
  const [status, setStatus] = useState<Approvals['status']>('loading');

  // Plain `useCallback` rather than a latest-ref: the effect below re-subscribes when this changes
  // identity, and that costs a restarted 60s window, but `auth` only changes identity once per
  // page — `AuthBoot` swaps the placeholder provider for the real one on resolve and never again.
  // Paying one interval restart at boot is cheaper than a ref written during render.
  const refresh = useCallback(() => {
    if (!ready) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    void (async () => {
      try {
        const next = await api.listApprovals(() => auth.getAccessToken());
        setHolds(next);
        setStatus('ok');
      } catch {
        // No banner. A hold nobody raised is the overwhelmingly common case, and a red bar on
        // every boot of a deployment without Temporal would train people to ignore banners that
        // do matter. The inbox says it in its own panel instead.
        setStatus('unavailable');
      }
    })();
  }, [auth, ready]);

  useEffect(() => {
    if (!ready) return;
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    // Both, and not just one: `visibilitychange` covers returning to a backgrounded tab, `focus`
    // covers coming back to a window that was never hidden — a second monitor, or another app on
    // top. A chemist alt-tabbing back is the moment the count has to be right.
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [ready, refresh]);

  const resolve = useCallback((approvalId: string) => {
    setHolds((current) => current.filter((hold) => hold.approval_id !== approvalId));
  }, []);

  return { holds, status, refresh, resolve };
}
