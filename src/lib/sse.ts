/**
 * Decode a fetch `Response` body as Server-Sent Events, tolerating the three things that are not
 * actually errors: a frame with no `data`, a single malformed JSON frame, and an event type this
 * build does not know about.
 *
 * `eventsource-parser` already handles multi-line `data:`, comment frames, CRLF, and frames split
 * across TCP chunk boundaries — this only adds the decode pipe, the JSON parse, and the
 * `normalizeEvent` step on top, because both of this app's SSE consumers (`streamTurn`,
 * `useJobStreams`) needed exactly that sequence and had drifted into maintaining it twice.
 *
 * Every frame is yielded, including the ones that carried nothing actionable, because both callers
 * need to know that *a frame arrived at all*: `useJobStreams` resets its reconnect backoff on any
 * live frame, not only ones it acts on, and `streamTurn` re-arms its stall timer on one and counts
 * the unusable ones — one malformed frame is a blip, every frame malformed is a version skew, and
 * without the count those were the same observation. `frame.drop` says why there is no event and
 * `frame.raw` is the parsed payload, which `streamTurn` reads a `correlation_id` out of whether or
 * not this build knows the frame's type. A caller that only cares about real events does
 * `if (!frame.event) continue`.
 *
 * The BFF's heartbeat (`: hb`) is an SSE *comment* and never reaches this parser at all —
 * `EventSourceParserStream` surfaces comments only through an `onComment` callback, which is
 * deliberately not passed. So a heartbeat is not a frame here, which is what lets `streamTurn`
 * treat every frame it does see as evidence the service itself is still producing, rather than
 * evidence that this app's own proxy is.
 *
 * Retry policy, terminal-event handling and what counts as "done" are deliberately NOT here: they
 * differ enough between the two callers (one never retries and stops at the first `answer`; the
 * other retries forever and never stops on its own) that folding them in here would just move the
 * duplication rather than remove it.
 */

import { EventSourceParserStream } from 'eventsource-parser/stream';
import { normalizeEvent, type ChemclawEvent } from '../../shared/events.ts';

/** One decoded SSE frame: what it meant, and — when it meant nothing — why. */
export interface SseFrame {
  /** The decoded event, or `null` when the frame carried nothing this build can act on. */
  event: ChemclawEvent | null;
  /** Why there is no event. Set exactly when `event` is `null`. */
  drop?: 'empty' | 'malformed' | 'unknown';
  /** The frame's JSON payload, when it parsed. Absent for an empty or malformed frame. */
  raw?: unknown;
  /** The frame's name: the payload's own `type` when it has one, else the SSE `event:` field,
   *  else `''`. Reported rather than guessed at, so a drop can be logged with what was dropped. */
  type: string;
}

/** The payload's own `type`, which is what the wire contract keys on — `value.event` is the
 *  fallback for a service that only sets the SSE event name. */
function frameName(raw: unknown, sseEventName: string): string {
  if (typeof raw === 'object' && raw !== null) {
    const type = (raw as { type?: unknown }).type;
    if (typeof type === 'string' && type) return type;
  }
  return sseEventName;
}

export async function* readEventStream(
  // Typed off `Response['body']` rather than a bare `ReadableStream<Uint8Array>`: the two callers
  // pass `res.body` straight through, and the DOM lib's exact `Uint8Array<ArrayBufferLike>`
  // parameterisation on that type is what makes `pipeThrough(new TextDecoderStream())` typecheck.
  body: NonNullable<Response['body']>,
): AsyncGenerator<SseFrame, void, void> {
  const reader = body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())
    .getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      const name = value.event ?? '';
      if (!value.data) {
        // A frame with an event name and no payload. Nothing in this contract sends one, but it
        // is a frame, and a caller counting arrivals must still see it.
        yield { event: null, drop: 'empty', type: name };
        continue;
      }

      let raw: unknown;
      try {
        raw = JSON.parse(value.data);
      } catch {
        // Tolerate a single malformed frame rather than killing an otherwise good stream.
        yield { event: null, drop: 'malformed', type: name };
        continue;
      }

      // Unknown event type: the backend's union is explicitly designed to grow, and an older
      // frontend must degrade rather than break — so it is a drop, not a failure.
      const event = normalizeEvent(raw, value.event);
      yield event
        ? { event, raw, type: event.type }
        : { event: null, drop: 'unknown', raw, type: frameName(raw, name) };
    }
  } finally {
    // Cancelling the body closes the socket. For `streamTurn` this is what turns a client Stop
    // into a disconnect the BFF and FastAPI can act on; for `useJobStreams` it is what makes an
    // aborted watch actually release the connection instead of leaking it.
    await reader.cancel().catch(() => undefined);
  }
}
