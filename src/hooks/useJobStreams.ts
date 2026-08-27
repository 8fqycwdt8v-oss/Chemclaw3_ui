/**
 * Consume `GET /sessions/{id}/events` — the async job push-back stream — for SEVERAL sessions.
 *
 * This is the channel that tells the UI a durable QM job finished, without polling. It used to
 * watch only the conversation that happened to be open, which is the one case where the chemist
 * would have noticed anyway: a conformer search takes minutes to hours, so the completion almost always
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
import { config } from '../env.ts';
import { retryAfterSeconds } from '../api/errors.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import type { AuthProvider } from '../auth/types.ts';
import { useChatStore } from '../state/chatStore.ts';
import { logger } from '../lib/logger.ts';
import { readEventStream } from '../lib/sse.ts';

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

/**
 * Consecutive failed connects before this stream is reported as failing.
 *
 * The module docstring names the hazard exactly — "a silent retry loop is exactly how this failure
 * hides" — and then only the 429 path acted on it. Every other failure (a 500, a 502, a TLS error,
 * a DNS error, a body that closes the instant it opens) fell into two identical silent branches:
 * an infinite retry loop, capped at 30 s, with no banner, no counter, no log and no store flag, so
 * durable job completions quietly stopped arriving and nothing anywhere recorded that they had.
 *
 * Four, because the backoff is 1, 2, 4, 8 s: past it the stream has been down for roughly half a
 * minute, which is long enough that this is not a rollout blipping and short enough that the
 * chemist has not yet been waiting for a completion that will never arrive.
 */
const FAILURES_BEFORE_REPORTING = 4;

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
    return () => {
      controllers.forEach((c) => c.abort());
      // A stream nobody is watching cannot be failing. Without this, dropping a conversation out
      // of the watch set would leave its indicator up for the life of the page.
      sessionIds.forEach((id) => useChatStore.getState().setJobStreamFailing(id, false));
    };
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
  /** Connects that produced no frame, in a row. Reset by a frame, never by a connect. */
  let failures = 0;

  /**
   * Record one connect that delivered nothing, and say so once it has happened enough times.
   *
   * The log line is per attempt because the shape of the failure is what an operator needs — a
   * 502 every time is an ingress, a 401 once is a token, a clean close every time is a pod coming
   * up — and the store flag is once, because it drives an indicator rather than a stream of them.
   */
  const failed = (reason: string, status?: number): void => {
    failures += 1;
    logger.warn('jobstream.connect_failed', {
      sessionId,
      reason,
      ...(status ? { status } : {}),
      attempt: failures,
    });
    if (failures >= FAILURES_BEFORE_REPORTING) {
      useChatStore.getState().setJobStreamFailing(sessionId, true);
    }
  };

  /** A frame arrived, so this stream is doing its job. */
  const delivering = (): void => {
    if (failures === 0) return;
    failures = 0;
    useChatStore.getState().setJobStreamFailing(sessionId, false);
  };

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
      //
      // Except when the 429 is not this cap at all. The per-principal *request* limiter refuses
      // inside `require_principal`, ahead of every route including this one, and says when to come
      // back in `Retry-After`; the stream cap sends no such header. Counting a limiter refusal as
      // evidence that this tab holds too many streams would drop it to one stream for the life of
      // the page over a budget that refills in seconds — so honour the number it sent, and leave
      // the counter alone. It is the same signal `errorFromStatus` splits the two 429s on.
      if (res.status === 429) {
        const wait = retryAfterSeconds(res.headers.get('retry-after'));
        if (wait !== null) {
          // Bounded by the same ceiling the backoff has. The limiter's own number is seconds, so
          // this never bites in practice; what it prevents is a header from somewhere else in the
          // path silently switching job push-back off for an hour.
          await sleep(Math.min(wait * 1_000, MAX_BACKOFF_MS), controller.signal);
          continue;
        }
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
        if (reauthed || !(await auth.handleUnauthorized())) {
          logger.warn('jobstream.unauthorized', { sessionId });
          return;
        }
        reauthed = true;
        continue;
      }

      if (!res.ok || !res.body) {
        attempt += 1;
        failed('status', res.status);
        await backoff(attempt, controller.signal);
        continue;
      }

      // `readEventStream` cancels its reader on the way out (loop exit, throw, or this iterator
      // being abandoned), so there is nothing left to clean up here.
      for await (const frame of readEventStream(res.body)) {
        // A frame arrived, so this connection is doing its job — only now is the escalation
        // reset. Resetting it at connect time meant a connect-then-immediately-close cycle
        // could repeat for ever without the delay ever growing. A frame this build cannot use
        // still counts as "arrived": it proves the connection is delivering, which is the only
        // question the backoff and the failure counter are asking.
        attempt = 0;
        delivering();
        if (!frame.event) continue;
        const event = frame.event;
        try {
          // Both endings, not just the happy one. This stream is scoped server-side to exactly
          // `job_completed` and `job_failed`, and a job that died after the turn ended is the
          // case the whole push-back path exists for — dropping it left the launch row saying
          // "runs asynchronously" indefinitely.
          if (event.type === 'job_completed' || event.type === 'job_failed') {
            // The event carries no session id — but we know which stream we opened, so the
            // association is attached here rather than by mutating the wire contract.
            useChatStore.getState().pushJobFinished(event, sessionId);
          }
        } catch {
          // one bad frame is not worth dropping the stream
        }
      }

      // The body ended with no error and no status to react to: a backend pod restarting
      // mid-rollout, a proxy hop closing the connection, an upstream failure after the headers.
      // Reconnecting is right — reconnecting *immediately* is what turned a rollout into ~300
      // connects per second per watched session, from every open tab, against the pod that was
      // still coming up. This is the same pacing every other retry path here already had.
      if (controller.signal.aborted) return;
      attempt += 1;
      // A body that ends without ever delivering a frame is a failure however clean the close
      // was: it is the rollout loop this file already paid for once, and the chemist's view of it
      // is the same as a 502's — completions stop arriving.
      failed('closed');
      await backoff(attempt, controller.signal);
    } catch {
      if (controller.signal.aborted) return;
      attempt += 1;
      // `fetch` itself threw: DNS, TLS, a refused connection. Indistinguishable here and worth
      // distinguishing in the log only by the fact that it is not a status.
      failed('transport');
      await backoff(attempt, controller.signal);
    }
  }
}

/** The longest this hook will ever wait before trying a stream again. */
const MAX_BACKOFF_MS = 30_000;

/** Exponential backoff with jitter, capped at `MAX_BACKOFF_MS`, abortable. */
function backoff(attempt: number, signal: AbortSignal): Promise<void> {
  const base = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempt, 5));
  return sleep(base * (0.5 + Math.random() * 0.5), signal);
}

/** Wait, resolving early if the stream is torn down — a timer nobody cancels outlives the tab's
 *  interest in the answer. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
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
