/**
 * Consume `GET /sessions/{id}/events` — the async job push-back stream.
 *
 * This is the channel that tells the UI a durable QM job finished, without polling. Two backend
 * constraints shape it:
 *
 *  - The backend caps concurrent event streams per user (429 past the cap), so we keep at most
 *    one open per session and close it when the session changes or the tab goes away.
 *  - Its claim is destructive and scoped to the two job-outcome kinds in SQL. We are one of two
 *    consumers racing for those rows (the agent's own mid-turn resume is the other), so a missed
 *    event is expected and must never be treated as an error.
 */

import { useEffect } from 'react';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { normalizeEvent } from '../../shared/events.ts';
import { config } from '../env.ts';
import type { AuthProvider } from '../auth/types.ts';
import { useEntityStore } from '../chem/entities.ts';
import { useChatStore } from '../state/chatStore.ts';

/**
 * `conversationId` and `sessionId` must name the *same* conversation — the entity rows this stream
 * closes belong to the conversation whose session it is subscribed to, and filing a completion
 * under a different one would leave the original row claiming "running" forever while a stranger's
 * rail grew a job it never started.
 */
export function useJobFeed(
  conversationId: string | null,
  sessionId: string | null,
  auth: AuthProvider,
): void {
  useEffect(() => {
    if (!sessionId || !conversationId) return;

    const controller = new AbortController();
    let stopped = false;
    let attempt = 0;

    const run = async (): Promise<void> => {
      while (!stopped) {
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

          // 429 means we are over the per-user stream cap. Backing off hard is the only correct
          // response — retrying tightly would keep us permanently over it.
          if (res.status === 429) {
            await backoff(6, controller.signal);
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
                // Both endings, because a job that failed has exactly the same claim on the
                // asker's attention as one that succeeded — and only one of the two used to have
                // a way to reach them. The backend claims both kinds off the mailbox in one
                // destructive read, so dropping `job_failed` here did not leave it for another
                // consumer; it destroyed it.
                if (event?.type === 'job_completed' || event?.type === 'job_failed') {
                  useChatStore.getState().pushJobOutcome(event);
                  // The entity rail's job row was left saying "running" by the turn that started
                  // it; this stream is the only thing that ever closes it. No message id to
                  // attribute the sighting to — the turn is long over — so it is stamped with the
                  // job's own id, which is the truthful answer to "where did this come from".
                  void useEntityStore
                    .getState()
                    .ingest(conversationId, `job:${event.job_id}`, event);
                }
              } catch {
                // one bad frame is not worth dropping the stream
              }
            }
          } finally {
            await reader.cancel().catch(() => undefined);
          }
        } catch {
          if (stopped || controller.signal.aborted) return;
          attempt += 1;
          await backoff(attempt, controller.signal);
        }
      }
    };

    void run();

    return () => {
      stopped = true;
      controller.abort();
    };
  }, [conversationId, sessionId, auth]);
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
