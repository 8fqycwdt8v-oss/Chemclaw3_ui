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
import {
  ApiError,
  correlationFrom,
  errorFromEvent,
  errorFromStatus,
  readFailure,
} from './errors.ts';
import { config } from '../env.ts';
import { readEventStream } from '../lib/sse.ts';

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
 * The backend documents two codes as sharing their turn with an answer — `loop_cap_reached` and
 * `spend_cap_reached`: a runaway guard, of iterations or of spend, stops a turn that has been
 * streaming text all along, so the event arrives after those tokens and BEFORE the `AnswerEvent`
 * they add up to — the same "mark it partial while it is still arriving" ordering
 * `capability_degraded` uses. (`budget_exhausted` is not one of them despite naming a budget: it
 * refuses a turn *before* it starts, so there is no partial answer to keep.)
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
const PARTIAL_ANSWER_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'loop_cap_reached',
  'spend_cap_reached',
]);

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
   * The service has taken this turn: the POST was answered `2xx`.
   *
   * Called at most once, and the caller needs it because *nothing else here distinguishes a turn
   * that is running on the server from one that never started*. `token_unavailable` above names
   * the one pre-flight failure that has its own kind; everything else that can go wrong before
   * this line — and everything `sendMessage` itself can throw while setting the turn up — reaches
   * its outer catch as a bare error and is wrapped as `stream`, which is the kind that means "the
   * turn may still be running, poll for it". This is the fact that tells those apart, and
   * `sendMessage` gates detach recovery on it rather than on the kind; see the comment there.
   */
  onAccepted?: () => void;
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
  let token: string | null;
  try {
    token = await opts.getToken();
  } catch (err) {
    // The provider itself failed before any request was opened — `msalAuth.getAccessToken`
    // deliberately rethrows a silent-refresh failure that is not `InteractionRequiredAuthError`
    // rather than resolving it, precisely so a network blip does not force a sign-in redirect.
    // Left uncaught, this used to escape as a bare, non-`ApiError` rejection that `sendMessage`'s
    // outer catch could only wrap as `kind: 'stream'` — the same kind a mid-turn disconnect gets
    // — which sent a turn that never reached the network into the ten-minute "the turn may still
    // be running server-side" recovery poll. It cannot be: `fetch` below has not been called yet.
    if (opts.signal.aborted) throw new ApiError('aborted', 'Stopped.');
    throw new ApiError(
      'token_unavailable',
      'Could not obtain a valid session token. Check your connection and try again.',
      undefined,
      { retryable: true },
    );
  }

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
    throw errorFromStatus(
      res.status,
      failure.detail,
      res.headers.get('retry-after'),
      failure.correlationId,
    );
  }

  // The service answered 2xx: it has this turn, and it will run it to completion and write it to
  // the session transcript whether or not this socket survives. Announced HERE rather than after
  // the content-type check below, because a 200 that is not an event stream means something
  // between us and the service swallowed the stream — the turn is still the service's, and
  // recovery is still the right answer for it.
  opts.onAccepted?.();

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
    // `readEventStream`'s own `finally` cancels the reader on the way out — including when this
    // loop `break`s below, since breaking a `for await` calls the generator's `return()`. That
    // cancel is what turns a client Stop into a disconnect the BFF and FastAPI can act on to
    // release the session's turn lock; without it, Stop would leave the next message 409-ing.
    for await (const frame of readEventStream(res.body)) {
      // The BFF's heartbeat is an SSE *comment* and never becomes a frame at all (`lib/sse.ts`
      // says why), and that is what makes the watch honest: the heartbeat is injected by this
      // app's proxy whether or not the service is still alive, so counting one as activity would
      // report a dead backend as a healthy one. A frame with no payload is no more evidence of a
      // live turn than a heartbeat is, so it is skipped on the same grounds.
      if (frame.drop === 'empty') continue;
      markFrame();

      if (frame.drop === 'malformed') {
        // Tolerate a single malformed frame rather than killing an otherwise good turn — and
        // count it, because a turn where EVERY frame is malformed is a different fault.
        opts.onFrameDropped?.({ reason: 'malformed', type: frame.type });
        continue;
      }

      // Any frame may carry the turn's id, whether or not this build knows the frame. That is what
      // makes a `turn_started` the service may start sending backwards-compatible in both
      // directions: it is used when present and nothing waits for it.
      let carriedCorrelation = false;
      if (typeof frame.raw === 'object' && frame.raw !== null) {
        const carried = (frame.raw as { correlation_id?: unknown }).correlation_id;
        if (typeof carried === 'string' && carried) {
          carriedCorrelation = true;
          noteCorrelation(carried);
        }
      }

      // Unknown event type: ignore it. The backend's union is explicitly designed to grow, and
      // an older frontend must degrade rather than break. Counted for the same reason a malformed
      // frame is — one is forward compatibility, every one is a version skew nobody was told about.
      if (!frame.event) {
        // A frame we took the turn's id out of is not a frame we failed to understand — counting
        // it as a version skew would report one on every turn the moment the service starts
        // sending a `turn_started`, which is precisely the change this path exists to absorb.
        if (carriedCorrelation) continue;
        opts.onFrameDropped?.({ reason: 'unknown', type: frame.type });
        continue;
      }
      const event = frame.event;

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
              retryAfterSeconds: failure.retryAfterSeconds,
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
    // The socket is closed by `readEventStream`'s own `finally`; what is left to undo here is the
    // idle timer, which must not outlive the turn it was watching.
    if (stallTimer) clearTimeout(stallTimer);
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
