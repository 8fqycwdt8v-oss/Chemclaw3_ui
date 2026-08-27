/**
 * Decode a fetch `Response` body as Server-Sent Events, tolerating the two things that are not
 * actually errors: a heartbeat comment frame (empty `data`) and a single malformed JSON frame.
 *
 * `eventsource-parser` already handles multi-line `data:`, comment frames, CRLF, and frames split
 * across TCP chunk boundaries — this only adds the decode pipe, the JSON parse, and the
 * `normalizeEvent` step on top, because both of this app's SSE consumers (`streamTurn`,
 * `useJobStreams`) needed exactly that sequence and had drifted into maintaining it twice.
 *
 * Yields `null` for a frame that decoded but carried nothing actionable (a heartbeat, malformed
 * JSON, or an event type this frontend does not know about) rather than skipping it silently, so a
 * caller that needs to know *a frame arrived at all* — `useJobStreams` resets its reconnect
 * backoff on any live frame, not only ones it acts on — still sees it. A caller that only cares
 * about real events, like `streamTurn`, just does `if (!event) continue`.
 *
 * Retry policy, terminal-event handling and what counts as "done" are deliberately NOT here: they
 * differ enough between the two callers (one never retries and stops at the first `answer`; the
 * other retries forever and never stops on its own) that folding them in here would just move the
 * duplication rather than remove it.
 */

import { EventSourceParserStream } from 'eventsource-parser/stream';
import { normalizeEvent, type ChemclawEvent } from '../../shared/events.ts';

export async function* readEventStream(
  // Typed off `Response['body']` rather than a bare `ReadableStream<Uint8Array>`: the two callers
  // pass `res.body` straight through, and the DOM lib's exact `Uint8Array<ArrayBufferLike>`
  // parameterisation on that type is what makes `pipeThrough(new TextDecoderStream())` typecheck.
  body: NonNullable<Response['body']>,
): AsyncGenerator<ChemclawEvent | null, void, void> {
  const reader = body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())
    .getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (!value.data) {
        yield null; // heartbeat comment: a live frame, but nothing to act on
        continue;
      }

      let raw: unknown;
      try {
        raw = JSON.parse(value.data);
      } catch {
        yield null; // tolerate a single malformed frame rather than killing an otherwise good stream
        continue;
      }

      // Unknown event type: the backend's union is explicitly designed to grow, and an older
      // frontend must degrade rather than break.
      yield normalizeEvent(raw, value.event);
    }
  } finally {
    // Cancelling the body closes the socket. For `streamTurn` this is what turns a client Stop
    // into a disconnect the BFF and FastAPI can act on; for `useJobStreams` it is what makes an
    // aborted watch actually release the connection instead of leaking it.
    await reader.cancel().catch(() => undefined);
  }
}
