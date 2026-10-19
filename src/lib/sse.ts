/**
 * Decode a fetch `Response` body as SSE for both consumers (`streamTurn`, `useJobStreams`),
 * tolerating frames with no `data`, malformed JSON and unknown event types. `eventsource-parser`
 * handles framing; this adds decoding, JSON parsing and `normalizeEvent`.
 *
 * Every frame is yielded, even unusable ones, because callers need to know a frame arrived:
 * `useJobStreams` resets backoff, and `streamTurn` re-arms its stall timer and counts malformed
 * frames. `frame.drop` says why there is no event; `frame.raw` is the parsed payload. Callers
 * wanting only events do `if (!frame.event) continue`. The BFF heartbeat (`: hb`) is an SSE comment
 * and never surfaces here (no `onComment`), so any frame is evidence the service itself is
 * producing. Retry and termination policy stay with the callers, which differ.
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
  /**
   * The frame's name: the payload's `type`, else the SSE `event:` field, else `''`; kept so a drop
   * can be logged.
   */
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
