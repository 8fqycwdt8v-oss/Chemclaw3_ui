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
 *  - The backend caps concurrent event streams per user and 429s past the cap. This repo does not
 *    know the cap's value, and the failure mode is invisible: the 429 path backs off and retries
 *    forever, so overshooting looks like "notifications quietly stopped". So there is an explicit
 *    client-side budget, and it only ever adjusts DOWNWARD when a 429 says we guessed high.
 *  - Its claim is destructive and scoped to `job_completed` in SQL. We are one of two consumers
 *    racing for those rows, so a missed event is expected and must never be treated as an error.
 *    More streams do not multiply delivery; they multiply racers.
 *  - A legitimately silent stream must stay open. Only the connect phase is bounded.
 */

import { useEffect } from 'react';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { normalizeEvent } from '../../shared/events.ts';
import { config } from '../env.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { useChatStore } from '../state/chatStore.ts';

/**
 * How many sessions to watch at once.
 *
 * Derived from what the feature needs — the active conversation, plus the two most recently used,
 * which covers "I launched a run, moved on, and it finished" — and NOT from a guess at the
 * backend's cap, which is unknown here. A number justified by the use case is defensible; one
 * justified by an invented cap is not.
 */
const MAX_JOB_STREAMS = 3;

export function useJobStreams(): void {
  const { auth, ready } = useAuth();
  /**
   * A stable, comparable key — derived INSIDE the selector, not from a subscription to the map.
   *
   * The conversations map is a fresh object on every store write, so subscribing to it re-rendered
   * this hook's host on every animation frame during a turn. That host is `AppShell`, so the whole
   * tree below it re-rendered at the token rate — the exact thing the store's own header says
   * selector-scoped subscriptions prevent. Returning the derived string instead means zustand
   * compares the string, and a frame that changes nothing about which sessions to watch does not
   * re-render anything.
   */
  const watchKey = useChatStore((s) => {
    const budget = s.jobStreamsThrottled ? 1 : MAX_JOB_STREAMS;
    const candidates = Object.values(s.conversations)
      .filter((c) => c.sessionId)
      // A conversation nobody has sent in has no job to report. This predicate is also what keeps
      // `warmSession` from inflating the stream count: warming gives a session, not a turn.
      .filter((c) => c.messages.length > 0 || c.id === s.activeId)
      .sort((a, b) => {
        if (a.id === s.activeId) return -1; // the active conversation is always watched
        if (b.id === s.activeId) return 1;
        return b.updatedAt - a.updatedAt;
      })
      .slice(0, budget)
      .map((c) => c.sessionId as string);
    return [...new Set(candidates)].join(',');
  });

  useEffect(() => {
    if (!ready || !watchKey) return;
    const sessionIds = watchKey.split(',').filter(Boolean);
    const controllers = sessionIds.map((sessionId) => {
      const controller = new AbortController();
      void openStream(sessionId, auth.getAccessToken, controller);
      return controller;
    });
    return () => controllers.forEach((c) => c.abort());
  }, [watchKey, auth, ready]);
}

async function openStream(
  sessionId: string,
  getToken: () => Promise<string | null>,
  controller: AbortController,
): Promise<void> {
  let attempt = 0;
  let consecutive429 = 0;

  while (!controller.signal.aborted) {
    try {
      const token = await getToken();
      const res = await fetch(`${config.apiBase}/sessions/${sessionId}/events`, {
        signal: controller.signal,
        cache: 'no-store',
        headers: {
          accept: 'text/event-stream',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });

      // Over the per-user stream cap. Backing off hard is necessary but not sufficient: a silent
      // retry loop is exactly how this failure hides. A second one in a row means our budget is
      // above the real cap, so we say so and drop to a single stream for the life of the page.
      if (res.status === 429) {
        consecutive429 += 1;
        if (consecutive429 >= 2) useChatStore.getState().setJobStreamsThrottled(true);
        await backoff(6, controller.signal);
        continue;
      }
      consecutive429 = 0;

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
            if (event?.type === 'job_completed') {
              // The event carries no session id — but we know which stream we opened, so the
              // association is attached here rather than by mutating the wire contract.
              useChatStore.getState().pushJobCompleted(event, sessionId);
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
