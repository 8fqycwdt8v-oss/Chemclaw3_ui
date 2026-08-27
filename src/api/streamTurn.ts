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

import type { AnswerEvent, ChemclawEvent, ErrorCode } from '../../shared/events.ts';
import { ApiError, errorFromEvent, errorFromStatus, readDetail } from './errors.ts';
import { config } from '../env.ts';
import { readEventStream } from '../lib/sse.ts';

/**
 * Error codes that qualify the answer still to come, rather than replacing it.
 *
 * The backend documents `loop_cap_reached` as "the only member that shares its turn with an
 * answer": the runaway guard stops a turn that has been streaming text all along, so the event
 * arrives after those tokens and BEFORE the `AnswerEvent` they add up to — the same
 * "mark it partial while it is still arriving" ordering `capability_degraded` uses.
 *
 * Treating it as terminal cost more than the badge. Throwing here runs the `finally` below, whose
 * `reader.cancel()` the BFF turns into a destroyed upstream request and FastAPI into a client
 * disconnect — so the backend's turn was cancelled at that yield, before `_record_transcript`. The
 * partial answer was lost from the live view AND from the durable transcript, on a turn that had
 * done all the work and was three events from delivering it.
 *
 * A set rather than an equality check because the shape is the backend's, not this code's: any
 * future code the backend orders before an answer belongs here, and one place is where that stays
 * true.
 */
const PARTIAL_ANSWER_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['loop_cap_reached']);

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

  let answer: AnswerEvent | null = null;

  try {
    // `readEventStream`'s own `finally` cancels the reader on the way out — including when this
    // loop `break`s below, since breaking a `for await` calls the generator's `return()`. That
    // cancel is what turns a client Stop into a disconnect the BFF and FastAPI can act on to
    // release the session's turn lock; without it, Stop would leave the next message 409-ing.
    for await (const event of readEventStream(res.body)) {
      if (!event) continue; // heartbeat, malformed frame, or an event type this frontend doesn't know

      // An `error` event ends the turn — with exactly one exception, which the backend names and
      // this client used to ignore. See `PARTIAL_ANSWER_CODES`.
      if (event.type === 'error' && !PARTIAL_ANSWER_CODES.has(event.code)) {
        throw errorFromEvent(event);
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
  }

  if (!answer) {
    throw new ApiError('stream', 'The stream ended before an answer arrived.');
  }
  return answer;
}
