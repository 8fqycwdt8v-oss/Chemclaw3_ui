/**
 * Consume `GET /sessions/{id}/events` — the durable-job push-back stream — for the active
 * conversation and the most recently used ones, so a completion is seen wherever the chemist is.
 *
 * - The backend caps event streams per user (429 beyond it). One tab per account holds the streams
 *   (`src/state/jobStreamLeader.ts`); every tab declares what it wants watched, and only the leader
 *   opens. The budget only ever moves down.
 * - The claim is destructive and shared with other consumers, so a missed event is expected, not an
 *   error.
 * - A silent stream stays open; only the connect phase is bounded.
 */

import { useEffect, useRef, useState } from 'react';
import { config } from '../env.ts';
import { retryAfterSeconds } from '../api/errors.ts';
import { exhibitPushed } from '../state/exhibitEvents.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import type { AuthProvider } from '../auth/types.ts';
import { useChatStore } from '../state/chatStore.ts';
import type { ChatState } from '../state/chatStore.ts';
import { logger } from '../lib/logger.ts';
import { readEventStream } from '../lib/sse.ts';
// The one backoff implementation.
import { MAX_BACKOFF_MS, backoff, sleep } from '../lib/backoff.ts';
import { createStreamLeader, type Note, type StreamLeader } from '../state/jobStreamLeader.ts';
import { reconcileAfterTakeover } from '../state/jobReconcile.ts';

/**
 * Sessions watched at once, per account: the active conversation plus two recent ones, under the
 * service's `service_max_event_streams_per_user` (default 5). The 429 path remains the backstop for
 * a tab that briefly believes it leads or a browser without `BroadcastChannel`.
 */
const MAX_JOB_STREAMS = 3;

/**
 * Consecutive failed connects before the stream is reported as failing (about 30 s of backoff), so
 * a rollout blip does not raise the indicator but real outages do.
 */
const FAILURES_BEFORE_REPORTING = 4;

/**
 * How long a tab must stay hidden before it counts as backgrounded, so alt-tabbing does not churn
 * streams.
 */
const HIDDEN_GRACE_MS = 30_000;

/**
 * Whether this tab has been hidden long enough; a hook so the change re-runs the store projection.
 */
function useBackgrounded(): boolean {
  const [backgrounded, setBackgrounded] = useState(false);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clear = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const onChange = (): void => {
      clear();
      // Coming back is immediate; going away waits out the grace period. Down slowly, up at once.
      if (!document.hidden) setBackgrounded(false);
      else timer = setTimeout(() => setBackgrounded(true), HIDDEN_GRACE_MS);
    };
    onChange();
    document.addEventListener('visibilitychange', onChange);
    return () => {
      clear();
      document.removeEventListener('visibilitychange', onChange);
    };
  }, []);

  return backgrounded;
}

/**
 * The sessions to watch, as one comma-joined string: a primitive, so a zustand selector re-renders
 * only when the set changes. Exported so tests can pin that a token flush does not move it.
 */
export function watchedSessionKey(s: ChatState, backgrounded = false): string {
  // `jobStreamsThrottled` (irreversible, this tab over its share) or `backgrounded` (reversible)
  // each cut to one stream. `backgrounded` defaults to false.
  const budget = s.jobStreamsThrottled || backgrounded ? 1 : MAX_JOB_STREAMS;
  const activeId = s.activeId;
  const candidates = Object.values(s.conversations)
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
}

/**
 * Apply one note — from this tab's streams or the leader's — to the store. The single path, so
 * followers and leader cannot diverge.
 */
function applyNote(note: Note): void {
  const store = useChatStore.getState();
  switch (note.kind) {
    case 'job':
      // Idempotent on `job_id`, so duplicates across a takeover cost nothing.
      store.pushJobFinished(note.event, note.sessionId);
      return;
    case 'awaiting':
      store.noteAwaiting(note.event);
      return;
    case 'exhibit':
      // Refetch, never open: a push is somebody else's act, not an answer to a question this
      // reader asked, so it must not take a column of their screen. See `exhibitPushed`.
      exhibitPushed(note.sessionId);
      return;
    case 'health': {
      // A follower holds no streams; relay the leader's failure state so the warning still shows.
      // Applied as a diff.
      for (const sessionId of store.jobStreamsFailing) {
        if (!note.failing.includes(sessionId)) store.setJobStreamFailing(sessionId, false);
      }
      for (const sessionId of note.failing) store.setJobStreamFailing(sessionId, true);
      // Reported, not adopted: another tab's throttle drives the indicator but never this tab's
      // irreversible flag.
      store.setJobStreamsThrottledElsewhere(note.throttled);
      return;
    }
  }
}

/** This tab's health, as it stands, for the followers. Read back from the store rather than
 *  tracked separately, so the note and the indicator cannot disagree. */
function publishHealth(tab: StreamLeader): void {
  const store = useChatStore.getState();
  tab.publish({
    kind: 'health',
    failing: store.jobStreamsFailing,
    throttled: store.jobStreamsThrottled,
  });
}

export function useJobStreams(): void {
  const { auth, ready } = useAuth();

  // Subscribe to a primitive projection (the watched-session key), not the conversations map, so
  // per-token store writes do not re-render `AppShell`.
  const backgrounded = useBackgrounded();
  // Re-projects on visibility change, trimming and restoring streams.
  const watchKey = useChatStore((s) => watchedSessionKey(s, backgrounded));
  /**
   * How many streams the account may hold. A hidden tab trims what it asks for, not what the
   * account holds; only `jobStreamsThrottled` cuts the budget.
   */
  const budget = useChatStore((s) => (s.jobStreamsThrottled ? 1 : MAX_JOB_STREAMS));

  /**
   * This tab's election membership for the life of the hook (mounted once by `AppShell`). A ref,
   * created lazily so StrictMode's remount does not hold an election against itself.
   */
  const membership = useRef<StreamLeader | null>(null);
  const tab = (): StreamLeader => (membership.current ??= createStreamLeader(applyNote));
  useEffect(
    () => () => {
      membership.current?.close();
      membership.current = null;
    },
    [],
  );

  // Asking is not opening: every tab declares its interest; only the leader opens streams.
  useEffect(() => {
    if (!ready) return;
    tab().declare(watchKey ? watchKey.split(',').filter(Boolean) : [], budget);
  }, [watchKey, budget, ready]);

  useEffect(() => {
    if (!ready) return;
    const joined = tab();
    /** The stream this tab holds for each session, so a change to the set moves only what moved. */
    const open = new Map<string, AbortController>();
    let held = false;

    const drop = (sessionId: string): void => {
      open.get(sessionId)?.abort();
      open.delete(sessionId);
      // A stream nobody watches cannot be failing; clear its indicator.
      useChatStore.getState().setJobStreamFailing(sessionId, false);
    };

    /**
     * Hold exactly the streams the election assigns, driven outside React state so leadership does
     * not re-render `AppShell`. A diff rather than a teardown, to save connects.
     */
    const sync = (): void => {
      const wanted = joined.watched();
      if (joined.isLeader() && !held) {
        // Taking over: clear failure warnings relayed by the previous leader.
        for (const sessionId of [...useChatStore.getState().jobStreamsFailing]) {
          useChatStore.getState().setJobStreamFailing(sessionId, false);
        }
        publishHealth(joined);
        // Ask the run registry how awaited runs ended: a leader that died before relaying an ending
        // took the only copy (`ISSUES.md` Issue 12). Also runs on the first election at page load.
        void reconcileAfterTakeover(joined, useChatStore.getState(), auth);
      }
      held = joined.isLeader();
      for (const sessionId of [...open.keys()]) if (!wanted.includes(sessionId)) drop(sessionId);
      for (const sessionId of wanted) {
        if (open.has(sessionId)) continue;
        const controller = new AbortController();
        open.set(sessionId, controller);
        void openStream(sessionId, auth, controller, joined);
      }
    };

    const unsubscribe = joined.subscribe(sync);
    sync();
    return () => {
      unsubscribe();
      for (const sessionId of [...open.keys()]) drop(sessionId);
    };
  }, [auth, ready]);
}

async function openStream(
  sessionId: string,
  auth: AuthProvider,
  controller: AbortController,
  tab: StreamLeader,
): Promise<void> {
  let attempt = 0;
  let consecutive429 = 0;
  let reauthed = false;
  /** Connects that produced no frame, in a row. Reset by a frame, never by a connect. */
  let failures = 0;

  /**
   * Record a connect that delivered nothing: log every attempt (the pattern helps an operator),
   * flag the store once past the threshold.
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
      publishHealth(tab);
    }
  };

  /** A frame arrived, so this stream is doing its job. */
  const delivering = (): void => {
    // A connection that delivered proves its credential, so the one-shot re-auth is re-armed for
    // the next 401.
    reauthed = false;
    if (failures === 0) return;
    failures = 0;
    useChatStore.getState().setJobStreamFailing(sessionId, false);
    publishHealth(tab);
  };

  while (!controller.signal.aborted) {
    try {
      const token = await auth.getAccessToken();
      const res = await fetch(
        `${config.apiBase}/sessions/${encodeURIComponent(sessionId)}/events`,
        {
          signal: controller.signal,
          cache: 'no-store',
          headers: {
            accept: 'text/event-stream',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        },
      );

      // A 429 is either the stream cap or the request limiter. The limiter sends `Retry-After`;
      // honour it without counting it against the stream budget. Two consecutive cap refusals mean
      // another window holds streams: drop to one stream for the life of the page (no recovery, to
      // avoid oscillating).
      if (res.status === 429) {
        // The header's presence picks the branch; parsing only supplies the number (as in
        // `errorFromStatus`).
        const header = res.headers.get('retry-after');
        if (header?.trim()) {
          // Present but unreadable: use the backoff, never `sleep(0)`.
          const wait = retryAfterSeconds(header);
          // Limiter refusals count as failed connects; past the reporting threshold the backoff
          // replaces the header's wait. `jobStreamsThrottled` is not set (that is about the stream
          // cap).
          attempt += 1;
          failed('rate_limited', 429);
          if (failures >= FAILURES_BEFORE_REPORTING || wait === null) {
            await backoff(attempt, controller.signal);
          } else {
            // Capped at the backoff ceiling, so a stray header cannot switch push-back off for an
            // hour.
            await sleep(Math.min(wait * 1_000, MAX_BACKOFF_MS), controller.signal);
          }
          continue;
        }
        // Cap refusals are counted and reported like any other failure.
        consecutive429 += 1;
        if (consecutive429 >= 2) {
          useChatStore.getState().setJobStreamsThrottled(true);
          publishHealth(tab);
        }
        attempt += 1;
        failed('stream_cap', 429);
        // Wait at least the backoff ceiling for a cap refusal (slots are held elsewhere); `attempt`
        // still counts failures.
        await backoff(Math.max(attempt, 6), controller.signal);
        continue;
      }
      consecutive429 = 0;

      // A 401 is not a transport failure: ask the provider to recover once; if it cannot, stop
      // watching (the turn path will prompt sign-in).
      if (res.status === 401) {
        // `handleUnauthorized` may reject (the dev provider does, with an actionable message), so
        // catch it here rather than as a transport error. Asked at most once per rejection.
        let recovered = false;
        if (!reauthed) {
          try {
            recovered = await auth.handleUnauthorized();
          } catch {
            // A provider that cannot even attempt recovery has answered the question: it cannot.
            recovered = false;
          }
        }
        // Check for abort before the store write, or a stale indicator could be left on an
        // unwatched session.
        if (controller.signal.aborted) return;
        if (reauthed || !recovered) {
          logger.warn('jobstream.unauthorized', { sessionId });
          // A permanent stop: raise the indicator now, not after the failure threshold.
          useChatStore.getState().setJobStreamFailing(sessionId, true);
          publishHealth(tab);
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

      // Whether this connection delivered anything (see the close handling).
      let sawFrame = false;
      for await (const frame of readEventStream(res.body)) {
        sawFrame = true;
        // A frame arrived (usable or not), so the connection works: reset the backoff.
        attempt = 0;
        delivering();
        if (!frame.event) continue;
        const event = frame.event;
        try {
          // Both job endings: a job failing after the turn is what this stream is for.
          if (event.type === 'job_completed' || event.type === 'job_failed') {
            // The event has no session id; attach the stream's. `publish` so other windows get it.
            tab.publish({ kind: 'job', event, sessionId });
          } else if (event.type === 'awaiting_answer') {
            // A durable request opening or expiring, into its own slice; an expiry removes the
            // badge.
            tab.publish({ kind: 'awaiting', event });
          } else if (event.type === 'exhibit') {
            // A human's artefact revision or pin, published since this tab may hold the only
            // stream.
            tab.publish({ kind: 'exhibit', sessionId });
          }
        } catch {
          // one bad frame is not worth dropping the stream
        }
      }

      // The body ended without error (pod restart, proxy close): reconnect with backoff, never
      // immediately.
      if (controller.signal.aborted) return;
      attempt += 1;
      // A close with no frame ever delivered is a failure; a healthy stream's ordinary reconnect is
      // not.
      if (!sawFrame) failed('closed');
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
