/**
 * Run one turn and consume its Server-Sent Event stream.
 *
 * The chat endpoint is SSE *over POST*, so the native `EventSource` is unusable — it is GET-only
 * and cannot set an `Authorization` header. We use `fetch` plus `eventsource-parser`, which
 * correctly handles multi-line `data:`, comment frames, CRLF, and — the one that actually bites —
 * frames split across TCP chunk boundaries.
 *
 * Deliberately NOT `@microsoft/fetch-event-source`: it was last published in April 2021, and its
 * default behaviour is to auto-retry a failed stream. Retrying a non-idempotent POST here either
 * double-spends the turn budget or collides with the backend's per-session turn lock and comes
 * back 409. Retry policy belongs to the caller, which knows whether a retry is safe.
 */

import { EventSourceParserStream } from 'eventsource-parser/stream';
import { normalizeEvent, type AnswerEvent, type ChemclawEvent } from '../../shared/events.ts';
import { ApiError, errorFromStatus, readDetail } from './errors.ts';
import { config } from '../env.ts';

export interface StreamTurnOptions {
  sessionId: string;
  message: string;
  /** Plan the turn without launching anything expensive (the backend's `dry_run`). */
  dryRun?: boolean;
  signal: AbortSignal;
  /** Resolves to `null` in dev-auth mode, in which case no Authorization header is sent. */
  getToken: () => Promise<string | null>;
  onEvent: (event: ChemclawEvent) => void;
}

/**
 * Runs exactly one turn. Resolves with the terminal `AnswerEvent`; throws `ApiError` otherwise.
 *
 * Never retries internally — see the module docstring.
 */
export async function streamTurn(opts: StreamTurnOptions): Promise<AnswerEvent> {
  const token = await opts.getToken();

  let res: Response;
  try {
    res = await fetch(`${config.apiBase}/sessions/${encodeURIComponent(opts.sessionId)}/messages`, {
      method: 'POST',
      signal: opts.signal,
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ message: opts.message, dry_run: opts.dryRun ?? false }),
    });
  } catch {
    if (opts.signal.aborted) throw new ApiError('aborted', 'Stopped.');
    throw new ApiError('network', 'Could not reach the Chemclaw service.');
  }

  if (!res.ok) throw errorFromStatus(res.status, await readDetail(res));

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream') || !res.body) {
    // Nearly always means something between us and the service swallowed the stream, or the
    // BFF's route whitelist answered with its own JSON 404.
    throw new ApiError('stream', `Expected an event stream but received "${contentType}".`);
  }

  const reader = res.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())
    .getReader();

  let answer: AnswerEvent | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value.data) continue; // heartbeat comments never reach here

      let raw: unknown;
      try {
        raw = JSON.parse(value.data);
      } catch {
        // Tolerate a single malformed frame rather than killing an otherwise good turn.
        continue;
      }

      const event = normalizeEvent(raw, value.event);
      // Unknown event type: ignore it. The backend's union is explicitly designed to grow, and
      // an older frontend must degrade rather than break.
      if (!event) continue;

      if (event.type === 'error') {
        throw new ApiError('agent', event.message);
      }

      opts.onEvent(event);

      if (event.type === 'answer') {
        answer = event;
        break;
      }
    }
  } catch (err) {
    if (opts.signal.aborted) throw new ApiError('aborted', 'Stopped.');
    if (err instanceof ApiError) throw err;
    throw new ApiError('stream', err instanceof Error ? err.message : 'The stream failed.');
  } finally {
    // Cancelling the body closes the socket, which the BFF turns into a destroyed upstream
    // request, which FastAPI sees as a client disconnect and uses to cancel the turn and release
    // the session's turn lock. Without this, Stop would leave the next message 409-ing.
    await reader.cancel().catch(() => undefined);
  }

  if (!answer) {
    throw new ApiError('stream', 'The stream ended before an answer arrived.');
  }
  return answer;
}
