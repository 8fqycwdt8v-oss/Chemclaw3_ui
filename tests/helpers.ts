/**
 * Test helpers.
 *
 * These stub `fetch` with canned SSE bytes. That is not a mock backend — no process is started —
 * it is the only practical way to exercise paths a healthy service will not produce on demand:
 * a frame split across chunk boundaries, a malformed frame, a stream that ends without an answer,
 * and each error status.
 */

import type { AnswerEvent, ChemclawEvent, ErrorEvent, ToolResultEvent } from '../shared/events.ts';

/**
 * Builders for the three events whose contracts carry more fields than any one test cares about.
 *
 * The fields are required on the union rather than optional, deliberately: the last three times a
 * field was added to this contract, the frontend went on compiling and quietly ignored it. Being
 * forced to name the new field at every construction site is the mechanism that stops that, and a
 * builder per event keeps the cost to the tests that genuinely do not care.
 *
 * Every default here matches what the service sends when nothing interesting happened — not what
 * is convenient — so a test that overrides nothing is testing the ordinary case.
 */
export function answerEvent(over: Partial<AnswerEvent> = {}): AnswerEvent {
  return {
    type: 'answer',
    text: '',
    confidence: null,
    unsupported_claims: [],
    review_required: false,
    verified_by: null,
    ...over,
  };
}

export function toolResultEvent(over: Partial<ToolResultEvent> = {}): ToolResultEvent {
  return {
    type: 'tool_result',
    tool: 'gather_evidence',
    preview: '',
    result_ref: '',
    note_ids: [],
    numbers: [],
    ...over,
  };
}

export function errorEvent(over: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    type: 'error',
    message: 'The turn failed.',
    code: 'internal',
    retryable: false,
    correlation_id: '',
    ...over,
  };
}

/** Serialise events the way sse-starlette does: both the `event:` name and the JSON `type`. */
export function sseFrames(events: ChemclawEvent[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

/** A ReadableStream of `text`, emitted in fixed-size byte chunks. `chunkSize: 3` deliberately
 *  splits frames mid-token, which is exactly what a real TCP stream does. */
export function byteStream(text: string, chunkSize = 1024): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

export function sseResponse(body: string, chunkSize = 1024): Response {
  return new Response(byteStream(body, chunkSize), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

export function jsonError(status: number, detail: string): Response {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Install a fetch stub; returns a restore function and the recorded calls. */
export function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
