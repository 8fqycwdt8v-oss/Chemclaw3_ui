/**
 * Consume `GET /sessions/{id}/events` — the async job push-back stream.
 *
 * This is the channel that tells the UI a durable QM job finished, without polling. Two backend
 * constraints shape it:
 *
 *  - The backend caps concurrent event streams per user (429 past the cap), so we keep at most
 *    one open per session and close it when the session changes or the tab goes away.
 *  - Its claim is destructive and scoped to `job_completed` in SQL. We are one of two consumers
 *    racing for those rows (the agent's own mid-turn resume is the other), so a missed event is
 *    expected and must never be treated as an error.
 */

import { useEffect } from 'react';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { normalizeEvent } from '../../shared/events.ts';
import { paths } from '../api/endpoints.ts';
import { config } from '../env.ts';
import type { AuthProvider } from '../auth/types.ts';
import { useChatStore } from '../state/chatStore.ts';

export function useJobFeed(sessionId: string | null, auth: AuthProvider): void {
  useEffect(() => {
    if (!sessionId) return;

    const controller = new AbortController();
    let stopped = false;
    let attempt = 0;

    const run = async (): Promise<void> => {
      while (!stopped) {
        try {
          const token = await auth.getAccessToken();
          const res = await fetch(`${config.apiBase}${paths.events(sessionId)}`, {
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
            // Release the connection before retrying; the body was never read.
            await res.body?.cancel().catch(() => undefined);
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
                // Both outcomes, not just the happy one. The stream claims kinds
                // ("job_completed", "job_failed") and this matched only the first, so a job that
                // was announced as running and then failed produced nothing at all here — the
                // card stayed "running" indefinitely with no way to learn otherwise.
                if (event?.type === 'job_completed' || event?.type === 'job_failed') {
                  useChatStore.getState().pushJobEvent(event);
                }
              } catch {
                // one bad frame is not worth dropping the stream
              }
            }
          } finally {
            await reader.cancel().catch(() => undefined);
          }

          // A floor delay on every reconnect, including a clean one.
          //
          // `attempt` resets to 0 on a successful response, and a stream that ends normally used
          // to fall straight back into the loop and re-fetch with no delay at all — so a backend
          // that closes this stream promptly (an idle timeout, a pod recycle, an ingress capping
          // stream duration) turned this into an unthrottled request loop against the one endpoint
          // whose docstring says it is rate-limited per user. It would hammer until it earned the
          // 429 and only then back off.
          if (!stopped) await settle(RECONNECT_FLOOR_MS, controller.signal);
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
  }, [sessionId, auth]);
}

/**
 * Shortest gap between two connections to the push-back stream, however cleanly the last one
 * ended. Long enough that a fast-closing server cannot turn this into a spin loop, short enough
 * that a job completing during the gap is noticed promptly.
 */
const RECONNECT_FLOOR_MS = 1_000;

/** Exponential backoff with jitter, capped at 30s, abortable. */
function backoff(attempt: number, signal: AbortSignal): Promise<void> {
  const base = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
  return settle(base * (0.5 + Math.random() * 0.5), signal);
}

/** Wait `delay` ms, resolving early if aborted. */
function settle(delay: number, signal: AbortSignal): Promise<void> {
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
