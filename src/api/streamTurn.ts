/**
 * Run one turn and consume its Server-Sent Event stream. SSE over POST, so `EventSource` (GET-only,
 * no headers) is unusable: `fetch` plus `eventsource-parser`, which handles multi-line data,
 * comments, CRLF and frames split across chunks. No auto-retrying SSE library: re-sending a POST
 * could double-spend or hit the session's turn lock; retry policy is the caller's.
 */

import type { ExhibitRef } from '../../shared/exhibitConstants.ts';
import type { AnswerEvent, ChemclawEvent, ErrorCode } from '../../shared/events.ts';
import {
  ApiError,
  correlationFrom,
  errorFromEvent,
  errorFromStatus,
  isReferenceRefusal,
  readFailure,
} from './errors.ts';
import { config } from '../env.ts';
import { readEventStream } from '../lib/sse.ts';

/**
 * How long a turn may produce no frame before the reader is told the chain may be broken. Not an
 * abort: the proxy has no timeouts (a 600 s turn is legitimate), and a healthy turn never goes this
 * long without a frame.
 */
export const TURN_STALL_MS = 90_000;

/** The header a watch response names its turn in — see `StreamTurnOptions.onWatching`. */
export const TURN_CORRELATION_HEADER = 'x-chemclaw-turn-correlation-id';

/**
 * Error codes that qualify an answer still to come rather than ending the turn (`loop_cap_reached`,
 * `spend_cap_reached`): they arrive after the tokens and before the `AnswerEvent`. Throwing on them
 * would cancel the stream before the service records the transcript, losing the partial answer.
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
  /**
   * Artefacts the chemist attached (`exhibit_refs`, at most five, `{exhibit_id, revision}` with `0`
   * = head). The service puts a framed copy of each in front of the model as data; an unknown one
   * is a 422.
   */
  exhibitRefs?: readonly ExhibitRef[];
  /**
   * Follow the session's running turn (`GET /sessions/{id}/turn/stream`) instead of starting one:
   * after `stream_lagged`, or to watch another member's turn. Events from the gap are not replayed,
   * but the final `answer` is the whole text. A 404 means no turn runs on that replica; the
   * transcript has it.
   */
  watch?: boolean;
  /**
   * With `watch`: which turn this is a view of (`X-Chemclaw-Turn-Correlation-Id`, the sender's id),
   * `''` if not said. Called before the first frame so a caller can abort on someone else's turn.
   */
  onWatching?: (turnCorrelationId: string) => void;
  signal: AbortSignal;
  /** Resolves to `null` in dev-auth mode, in which case no Authorization header is sent. */
  getToken: () => Promise<string | null>;
  onEvent: (event: ChemclawEvent) => void;
  /**
   * The service's id for this turn, from `X-Chemclaw-Correlation-Id` or any frame carrying
   * `correlation_id`; reported on successful turns too.
   */
  onCorrelationId?: (correlationId: string) => void;
  /**
   * The service took this turn (POST answered 2xx). Called at most once; `sendMessage` gates detach
   * recovery on it, since a failure before this point never reached the service.
   */
  onAccepted?: () => void;
  /** The stream went quiet for `stallAfterMs` (and later `false`). Reported, never acted on. */
  onStall?: (stalled: boolean) => void;
  /** Overrides `TURN_STALL_MS`; `0` switches the detector off. Tests use it; nothing else does. */
  stallAfterMs?: number;
  /**
   * A frame this build could not use (malformed or unknown type), so a version skew is visible
   * rather than silent.
   */
  onFrameDropped?: (drop: { reason: 'malformed' | 'unknown'; type: string }) => void;
}

/**
 * Runs exactly one turn. Resolves with the terminal `AnswerEvent`; throws `ApiError` otherwise.
 * Never retries.
 */
export async function streamTurn(opts: StreamTurnOptions): Promise<AnswerEvent> {
  let token: string | null;
  try {
    token = await opts.getToken();
  } catch (err) {
    // Token acquisition failures are thrown as `ApiError` before any request, so they are never
    // mistaken for a dropped stream.
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
    // Each URL written out whole, because the contract check reads the route off the literal.
    const session = encodeURIComponent(opts.sessionId);
    const authorization: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    res = opts.watch
      ? await fetch(`${config.apiBase}/sessions/${session}/turn/stream`, {
          method: 'GET',
          signal: opts.signal,
          cache: 'no-store',
          headers: { accept: 'text/event-stream', ...authorization },
        })
      : await fetch(`${config.apiBase}/sessions/${session}/messages`, {
          method: 'POST',
          signal: opts.signal,
          cache: 'no-store',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            ...authorization,
          },
          // `exhibit_refs` always, `[]` when there are none: the contract's own default, and a
          // service older than the field ignores an unknown key rather than refusing it.
          body: JSON.stringify({
            message: opts.message,
            dry_run: opts.dryRun ?? false,
            exhibit_refs: opts.exhibitRefs ?? [],
          }),
        });
  } catch {
    if (opts.signal.aborted) throw new ApiError('aborted', 'Stopped.');
    throw new ApiError('network', 'Could not reach the Chemclaw service.');
  }

  if (!res.ok) {
    const failure = await readFailure(res);
    // A 422 about attached artefacts has its own kind: by the service's `invalid_exhibit_ref` code,
    // else (older services) by wording when references were sent.
    if (
      res.status === 422 &&
      (failure.code === 'invalid_exhibit_ref' ||
        ((opts.exhibitRefs?.length ?? 0) > 0 && isReferenceRefusal(failure.detail)))
    ) {
      throw new ApiError(
        'invalid_reference',
        failure.detail ||
          'An artefact attached to this message is not one this conversation holds.',
        422,
        failure.correlationId ? { correlationId: failure.correlationId } : undefined,
      );
    }
    throw errorFromStatus(
      res.status,
      failure.detail,
      res.headers.get('retry-after'),
      failure.correlationId,
      // The turn route's 409 names which line refusal it is (`queue_full`, `already_waiting`).
      failure.code,
    );
  }

  // 2xx: the service has the turn and will finish and record it even if this socket drops.
  // Announced before the content-type check, since a 2xx that is not an event stream still means
  // the turn is running.
  opts.onAccepted?.();
  if (opts.watch) opts.onWatching?.(res.headers.get(TURN_CORRELATION_HEADER)?.trim() ?? '');

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
      // Re-arm for the remainder: a frame that arrived while the timer was pending resets the
      // clock.
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
    // `readEventStream`'s `finally` cancels the reader on exit (including `break`), which
    // propagates a Stop as a disconnect.
    for await (const frame of readEventStream(res.body)) {
      // Heartbeats are SSE comments and never become frames; an empty frame is no evidence of a
      // live turn either, so neither resets the stall clock.
      if (frame.drop === 'empty') continue;
      markFrame();

      if (frame.drop === 'malformed') {
        // Tolerate a single malformed frame rather than killing an otherwise good turn — and
        // count it, because a turn where EVERY frame is malformed is a different fault.
        opts.onFrameDropped?.({ reason: 'malformed', type: frame.type });
        continue;
      }

      // Any frame may carry the turn id, known type or not.
      let carriedCorrelation = false;
      if (typeof frame.raw === 'object' && frame.raw !== null) {
        const carried = (frame.raw as { correlation_id?: unknown }).correlation_id;
        if (typeof carried === 'string' && carried) {
          carriedCorrelation = true;
          noteCorrelation(carried);
        }
      }

      // Unknown event type: ignore (the union is designed to grow), but count it.
      if (!frame.event) {
        // A frame we took the turn id from is not a version skew.
        if (carriedCorrelation) continue;
        opts.onFrameDropped?.({ reason: 'unknown', type: frame.type });
        continue;
      }
      const event = frame.event;

      // An `error` event ends the turn, except `PARTIAL_ANSWER_CODES`.
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
    // The reader is closed by `readEventStream`; clear the stall timer here.
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
