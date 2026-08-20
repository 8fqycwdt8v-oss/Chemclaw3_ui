/**
 * Consume `GET /sessions/{id}/events` — the async job push-back stream — for SEVERAL sessions.
 *
 * This is the channel that tells the UI a durable QM job finished, without polling. It used to
 * watch only the conversation that happened to be open, which is the one case where the chemist
 * would have noticed anyway: a DFT run takes minutes to days, so the completion almost always
 * lands while they are somewhere else. Now the recently-active conversations are watched too.
 *
 * Three backend constraints shape this, all of them still true:
 *
 *  - The backend caps concurrent event streams per user and 429s past the cap. The cap's value is
 *    now known — see `MAX_JOB_STREAMS` — but the failure mode is unchanged: the 429 path backs off
 *    and retries forever, so overshooting looks like "notifications quietly stopped". So there is
 *    an explicit client-side budget, and it only ever adjusts DOWNWARD.
 *  - Its claim is destructive and scoped to `job_completed` in SQL. We are one of two consumers
 *    racing for those rows, so a missed event is expected and must never be treated as an error.
 *    More streams do not multiply delivery; they multiply racers.
 *  - A legitimately silent stream must stay open. Only the connect phase is bounded.
 */

import { useEffect, useMemo } from 'react';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { normalizeEvent } from '../../shared/events.ts';
import { config } from '../env.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import type { AuthProvider } from '../auth/types.ts';
import { useChatStore } from '../state/chatStore.ts';

/**
 * How many sessions to watch at once.
 *
 * Chosen from what the feature needs — the active conversation, plus the two most recently used,
 * which covers "I launched a run, moved on, and it finished" — and now checked against the real
 * cap rather than left as a defensible guess. The service's is
 * `service_max_event_streams_per_user`, default **5** (`chemclaw/core/config/service.py`), enforced
 * in `routes/streams.py` beside a per-pod total. Three fits under five, so the number stands; what
 * changed is that it is a measured margin instead of a hope.
 *
 * The margin is thinner than it looks, and that is the part worth knowing. The cap is **per
 * principal, per process, counted across connections** — it has no idea what a tab is. Two windows
 * on one account ask for six against a cap of five, so the second window's last stream 429s.
 * Nothing here can see the other tab: the count lives in the pod's memory, and a client-side budget
 * can only bound its own. So the overshoot is real, expected in a two-window workflow, and handled
 * rather than prevented — the 429 path below drops this tab to a single stream, which brings the
 * pair back under the cap. Preventing it properly means one tab holding the streams for all of
 * them (a `BroadcastChannel` leader election), which is a feature and not a constant; it is filed
 * in ISSUES.md rather than half-built here.
 */
const MAX_JOB_STREAMS = 3;

export function useJobStreams(): void {
  const { auth, ready } = useAuth();
  const conversations = useChatStore((s) => s.conversations);
  const activeId = useChatStore((s) => s.activeId);
  const throttled = useChatStore((s) => s.jobStreamsThrottled);

  // A stable, comparable key. The conversations map is a fresh object on every store write, so a
  // raw array here would tear down and reopen every stream once per animation frame while a turn
  // streams — zustand v5 has no implicit shallow compare to save us.
  const watchKey = useMemo(() => {
    const budget = throttled ? 1 : MAX_JOB_STREAMS;
    const candidates = Object.values(conversations)
      .filter((c) => c.sessionId)
      // A conversation nobody has sent in has no job to report. This predicate is also what keeps
      // `warmSession` from inflating the stream count: warming gives a session, not a turn.
      .filter((c) => c.messages.length > 0 || c.id === activeId)
      .sort((a, b) => {
        if (a.id === activeId) return -1; // the active conversation is always watched
        if (b.id === activeId) return 1;
        return b.updatedAt - a.updatedAt;
      })
      .slice(0, budget)
      .map((c) => c.sessionId as string);
    return [...new Set(candidates)].join(',');
  }, [conversations, activeId, throttled]);

  useEffect(() => {
    if (!ready || !watchKey) return;
    const sessionIds = watchKey.split(',').filter(Boolean);
    const controllers = sessionIds.map((sessionId) => {
      const controller = new AbortController();
      void openStream(sessionId, auth, controller);
      return controller;
    });
    return () => controllers.forEach((c) => c.abort());
  }, [watchKey, auth, ready]);
}

async function openStream(
  sessionId: string,
  auth: AuthProvider,
  controller: AbortController,
): Promise<void> {
  let attempt = 0;
  let consecutive429 = 0;
  let reauthed = false;

  while (!controller.signal.aborted) {
    try {
      const token = await auth.getAccessToken();
      const res = await fetch(`${config.apiBase}/sessions/${sessionId}/events`, {
        signal: controller.signal,
        cache: 'no-store',
        headers: {
          accept: 'text/event-stream',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });

      // Over the per-user stream cap (`service_max_event_streams_per_user`, default 5, shared
      // across this account's tabs). Backing off hard is necessary but not sufficient: a silent
      // retry loop is exactly how this failure hides. A second one in a row means this tab's share
      // of the cap is smaller than its budget — almost always a second window — so we say so and
      // drop to a single stream for the life of the page.
      //
      // Still no recovery path, and still deliberately: raising the budget again after a quiet
      // spell would flap against whatever else holds the cap, and the cost of staying low is one
      // tab watching one conversation instead of three. Down is cheap; oscillating is not.
      if (res.status === 429) {
        consecutive429 += 1;
        if (consecutive429 >= 2) useChatStore.getState().setJobStreamsThrottled(true);
        await backoff(6, controller.signal);
        continue;
      }
      consecutive429 = 0;

      // A 401 is not a transport failure and must not be backed off like one. It used to fall
      // into the branch below — increment, wait, retry, forever — so an unrecoverable rejection
      // (a revoked token, a misconfigured audience after a redeploy) became an unbounded request
      // loop from every open tab, against a service whose per-principal rate budget cannot see
      // it: that budget lives *inside* the front door's `require_principal` and only spends after
      // validation succeeds.
      //
      // So: ask the provider to recover, once. Under MSAL that is usually invisible, because
      // `getAccessToken` already refreshes silently — reaching here means the refresh did not
      // help, which is precisely when retrying the same token forever is the wrong answer. If it
      // cannot recover, stop watching. The conversation still works; only push-back is lost, and
      // the turn path will surface the sign-in prompt on the next message.
      if (res.status === 401) {
        if (reauthed || !(await auth.handleUnauthorized())) return;
        reauthed = true;
        continue;
      }

      if (!res.ok || !res.body) {
        attempt += 1;
        await backoff(attempt, controller.signal);
        continue;
      }

      attempt = 0;
      const reader = res.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new EventSourceParserStream())
        .getReader();

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value.data) continue;
          try {
            const event = normalizeEvent(JSON.parse(value.data), value.event);
            // Both endings, not just the happy one. This stream is scoped server-side to exactly
            // `job_completed` and `job_failed`, and a job that died after the turn ended is the
            // case the whole push-back path exists for — dropping it left the launch row saying
            // "runs asynchronously" indefinitely.
            if (event?.type === 'job_completed' || event?.type === 'job_failed') {
              // The event carries no session id — but we know which stream we opened, so the
              // association is attached here rather than by mutating the wire contract.
              useChatStore.getState().pushJobFinished(event, sessionId);
            }
          } catch {
            // one bad frame is not worth dropping the stream
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    } catch {
      if (controller.signal.aborted) return;
      attempt += 1;
      await backoff(attempt, controller.signal);
    }
  }
}

/** Exponential backoff with jitter, capped at 30s, abortable. */
function backoff(attempt: number, signal: AbortSignal): Promise<void> {
  const base = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
  const delay = base * (0.5 + Math.random() * 0.5);
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delay);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
