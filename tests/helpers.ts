/**
 * Test helpers.
 *
 * These stub `fetch` with canned SSE bytes. That is not a mock backend — no process is started —
 * it is the only practical way to exercise paths a healthy service will not produce on demand:
 * a frame split across chunk boundaries, a malformed frame, a stream that ends without an answer,
 * and each error status.
 */

import type {
  AnswerEvent,
  ChemclawEvent,
  ErrorEvent,
  ToolResultEvent,
} from '../shared/events.ts';

/**
 * Builders for the three events that carry optional-on-the-backend fields.
 *
 * Every field below is one the service defaults, so a test that cares about `text` should not have
 * to restate `verified_by` to compile. That is not just ergonomics: these three events have grown
 * six fields between them since this suite was written, and each addition previously meant editing
 * fifteen unrelated call sites — the kind of churn that makes the easy fix "make the field
 * optional", which is how a consumer stops handling it at all.
 *
 * The defaults are the service's own, so a builder with no arguments is what a minimally-configured
 * deployment actually sends: verification off, no error classification.
 */
export const answerEvent = (over: Partial<AnswerEvent> = {}): AnswerEvent => ({
  type: 'answer',
  text: '',
  confidence: null,
  unsupported_claims: [],
  review_required: false,
  verified_by: null,
  ...over,
});

export const toolResultEvent = (over: Partial<ToolResultEvent> = {}): ToolResultEvent => ({
  type: 'tool_result',
  tool: 'unknown',
  preview: '',
  note_ids: [],
  numbers: [],
  ...over,
});

export const errorEvent = (over: Partial<ErrorEvent> = {}): ErrorEvent => ({
  type: 'error',
  message: 'The turn failed.',
  code: 'internal',
  retryable: false,
  correlation_id: '',
  ...over,
});

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
export function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
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
