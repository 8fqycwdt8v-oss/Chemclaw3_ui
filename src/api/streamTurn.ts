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
import {
  normalizeEvent,
  type AnswerEvent,
  type ChemclawEvent,
  type ErrorCode,
} from '../../shared/events.ts';
import {
  ApiError,
  correlationFrom,
  errorFromEvent,
  errorFromStatus,
  readFailure,
} from './errors.ts';
import { config } from '../env.ts';

/**
 * How long a turn may produce nothing before the reader is told the chain may be broken.
 *
 * Not an abort. `server/proxy.ts` disables every socket and body timeout on purpose — a 600 s turn
 * is legitimate — and `fetch` has no timeout of its own, so a backend that accepts the POST,
 * flushes headers and then dies is indistinguishable from a model that is thinking hard: the
 * reader sees "Thinking…" and a counter, for up to ten and a half minutes, with nothing recorded
 * anywhere. Ninety seconds is well past any gap a healthy turn produces (tokens, tool calls and
 * plan revisions all arrive as frames) and well short of the wall clock, so it separates the two
 * without ever cutting a turn short.
 */
export const TURN_STALL_MS = 90_000;

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
  /**
   * The service's id for this turn, the moment it is known.
   *
   * Read back from the response's `X-Chemclaw-Correlation-Id` and from any frame that carries a
   * `correlation_id` — the `error` event has always had one, and a `turn_started` frame would be
   * picked up here without a contract change on either side. It is reported even on a turn that
   * SUCCEEDS, which is the case that had no reference at all: "the answer at 14:32 cited the wrong
   * note" was unjoinable to anything the service logged.
   */
  onCorrelationId?: (correlationId: string) => void;
  /**
   * The stream went quiet for `stallAfterMs`, and later (with `false`) that it came back.
   *
   * Reported rather than acted on: this function deliberately does not abort, because a long turn
   * that is genuinely working looks the same from here and cutting it off would destroy the answer.
   */
  onStall?: (stalled: boolean) => void;
  /** Overrides `TURN_STALL_MS`; `0` switches the detector off. Tests use it; nothing else does. */
  stallAfterMs?: number;
  /**
   * A frame this build could not use, as it happened.
   *
   * Both drops are correct — one bad frame must not kill a good turn, and an unknown event type is
   * how an older frontend survives a newer service — and both are pinned by tests. What was
   * missing is that "one malformed frame" and "every frame is malformed" were the same
   * observation, so a version skew against a newer backend was silent by construction.
   */
  onFrameDropped?: (drop: { reason: 'malformed' | 'unknown'; type: string }) => void;
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

  if (!res.ok) {
    const failure = await readFailure(res);
    throw errorFromStatus(res.status, failure.detail, failure.correlationId);
  }

  // Known before the first frame, so every error below can quote it — including the ones that
  // happen when no frame ever arrives.
  let correlationId = correlationFrom(res);
  if (correlationId) opts.onCorrelationId?.(correlationId);
  const noteCorrelation = (id: string): void => {
    if (!id || id === correlationId) return;
    correlationId = id;
    opts.onCorrelationId?.(id);
  };
  /** Every error this function raises carries the turn's id, so no banner is left unjoinable. */
  const withReference = (): { correlationId: string } | undefined =>
    correlationId ? { correlationId } : undefined;

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream') || !res.body) {
    // Nearly always means something between us and the service swallowed the stream, or the
    // BFF's route whitelist answered with its own JSON 404.
    throw new ApiError(
      'stream',
      `Expected an event stream but received "${contentType}".`,
      undefined,
      withReference(),
    );
  }

  const reader = res.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())
    .getReader();

  let answer: AnswerEvent | null = null;

  // The idle watch. One timer, re-armed by each frame, so a quiet turn costs nothing until it has
  // actually been quiet — and cleared in the `finally`, so it cannot outlive the turn.
  const stallAfterMs = opts.stallAfterMs ?? TURN_STALL_MS;
  let lastFrameAt = Date.now();
  let stalled = false;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;

  const armStall = (delay: number): void => {
    if (stallAfterMs <= 0 || !opts.onStall) return;
    stallTimer = setTimeout(() => {
      const idle = Date.now() - lastFrameAt;
      // Re-arm for the remainder rather than firing early: `setTimeout` may run late, and a frame
      // that arrived while it was pending must reset the clock rather than be overruled by it.
      if (idle < stallAfterMs) {
        armStall(stallAfterMs - idle);
        return;
      }
      stalled = true;
      opts.onStall?.(true);
    }, delay);
  };

  const markFrame = (): void => {
    lastFrameAt = Date.now();
    if (stallTimer) clearTimeout(stallTimer);
    if (stalled) {
      stalled = false;
      opts.onStall?.(false);
    }
    armStall(stallAfterMs);
  };

  markFrame();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // A comment frame — the BFF's own heartbeat — never reaches here, and that is what makes
      // the watch honest: the heartbeat is injected by this app's proxy whether or not the service
      // is still alive, so counting one as activity would report a dead backend as a healthy one.
      if (!value.data) continue;
      markFrame();

      let raw: unknown;
      try {
        raw = JSON.parse(value.data);
      } catch {
        // Tolerate a single malformed frame rather than killing an otherwise good turn — and
        // count it, because a turn where EVERY frame is malformed is a different fault.
        opts.onFrameDropped?.({ reason: 'malformed', type: value.event ?? '' });
        continue;
      }

      // Any frame may carry the turn's id, whether or not this build knows the frame. That is what
      // makes a `turn_started` the service may start sending backwards-compatible in both
      // directions: it is used when present and nothing waits for it.
      let carriedCorrelation = false;
      if (typeof raw === 'object' && raw !== null) {
        const carried = (raw as { correlation_id?: unknown }).correlation_id;
        if (typeof carried === 'string' && carried) {
          carriedCorrelation = true;
          noteCorrelation(carried);
        }
      }

      const event = normalizeEvent(raw, value.event);
      // Unknown event type: ignore it. The backend's union is explicitly designed to grow, and
      // an older frontend must degrade rather than break. Counted for the same reason a malformed
      // frame is — one is forward compatibility, every one is a version skew nobody was told about.
      if (!event) {
        // A frame we took the turn's id out of is not a frame we failed to understand — counting
        // it as a version skew would report one on every turn the moment the service starts
        // sending a `turn_started`, which is precisely the change this path exists to absorb.
        if (carriedCorrelation) continue;
        const name =
          (typeof raw === 'object' &&
          raw !== null &&
          typeof (raw as { type?: unknown }).type === 'string'
            ? String((raw as { type?: unknown }).type)
            : value.event) ?? '';
        opts.onFrameDropped?.({ reason: 'unknown', type: name });
        continue;
      }

      // An `error` event ends the turn — with exactly one exception, which the backend names and
      // this client used to ignore. See `PARTIAL_ANSWER_CODES`.
      if (event.type === 'error' && !PARTIAL_ANSWER_CODES.has(event.code)) {
        const failure = errorFromEvent(event);
        // The event's own id wins; ours is the fallback for a service that stopped sending it on
        // the event but still sends the header.
        throw failure.correlationId
          ? failure
          : new ApiError(failure.kind, failure.message, failure.status, {
              retryable: failure.retryable,
              correlationId,
            });
      }

      opts.onEvent(event);

      if (event.type === 'answer') {
        answer = event;
        break;
      }
    }
  } catch (err) {
    if (opts.signal.aborted) throw new ApiError('aborted', 'Stopped.', undefined, withReference());
    if (err instanceof ApiError) throw err;
    throw new ApiError(
      'stream',
      err instanceof Error ? err.message : 'The stream failed.',
      undefined,
      withReference(),
    );
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    // Cancelling the body closes the socket, which the BFF turns into a destroyed upstream
    // request, which FastAPI sees as a client disconnect and uses to cancel the turn and release
    // the session's turn lock. Without this, Stop would leave the next message 409-ing.
    await reader.cancel().catch(() => undefined);
  }

  if (!answer) {
    throw new ApiError(
      'stream',
      'The stream ended before an answer arrived.',
      undefined,
      withReference(),
    );
  }
  return answer;
}
