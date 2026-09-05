/**
 * Test helpers.
 *
 * Most of these stub `fetch` with canned SSE bytes. That is not a mock backend — no process is
 * started — it is the only practical way to exercise paths a healthy service will not produce on
 * demand: a frame split across chunk boundaries, a malformed frame, a stream that ends without an
 * answer, and each error status.
 *
 * The two at the bottom are for the chemistry surfaces, and they are here rather than in one test
 * file because both the composer's paste tests and the structure panel's need them.
 */

import { fireEvent } from '@testing-library/react';
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
    challenged: false,
    review_hold_id: null,
    ...over,
  };
}

export function toolResultEvent(over: Partial<ToolResultEvent> = {}): ToolResultEvent {
  return {
    type: 'tool_result',
    tool: 'gather_evidence',
    preview: '',
    result_ref: '',
    // Both empty, and populated by `normalizeEvent` for the same reason `agent` is: the service
    // defaults them, so a builder used in `toEqual` has to name them. Empty `result_inline` is
    // "the result did not ride along", which is every result over the service's inline cap.
    result_inline: '',
    note_ids: [],
    numbers: [],
    values: [],
    // `normalizeEvent` always sets this, so a builder used in `toEqual` must too. Empty is the
    // main agent — the same default the backend serialises.
    agent: '',
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

/**
 * A stream that delivers `prefix` and then *errors*, rather than closing.
 *
 * The distinction this exists to make testable: `byteStream` ends cleanly, which is what a turn
 * that finished looks like. A dropped Wi-Fi, a killed pod or an ingress idle-timeout is the other
 * thing — the body raises mid-flight, and the reader's `read()` rejects instead of resolving
 * `{done: true}`. Those two arrive at the same `catch` in `streamTurn` and mean opposite things to
 * a chemist, so a test that only ever produces the clean ending cannot tell them apart.
 *
 * `beforeError` lets a test observe the socket breaking at a chosen moment — it runs after the
 * prefix has been enqueued and before the error is raised, which is where "the user had already
 * pressed Stop" and "nobody pressed anything" diverge.
 */
export function erroringStream(
  prefix: string,
  error: Error = new TypeError('network error'),
  beforeError?: () => void,
): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(prefix);
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        if (bytes.length > 0) controller.enqueue(bytes);
        return;
      }
      beforeError?.();
      controller.error(error);
    },
  });
}

/** A 200 that is a well-formed event stream right up to the moment the body breaks. */
export function brokenSseResponse(
  prefix: string,
  error?: Error,
  beforeError?: () => void,
): Response {
  return new Response(erroringStream(prefix, error, beforeError), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
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

/**
 * Paste `clip` into a text control the way a browser does — **in that order**.
 *
 * The order is the whole point and it is not the obvious one. A `paste` event fires *before* the
 * text is inserted, with the caret still at the insertion point, and the composer reads that caret
 * to record where the pasted token landed. A test that sets the value first and fires `paste`
 * afterwards is describing a paste that never happened: happy-dom (like a browser) leaves the
 * caret at the end of a programmatically set value, so the composer would be told the token was
 * pasted somewhere it was not.
 *
 * `at` defaults to the control's current caret. The insertion itself is the browser's default
 * action, which the composer deliberately does not prevent.
 */
export function pasteInto(
  el: HTMLTextAreaElement | HTMLInputElement,
  clip: string,
  at?: number,
): void {
  const caret = at ?? el.selectionStart ?? el.value.length;
  el.setSelectionRange(caret, caret);
  fireEvent.paste(el, { clipboardData: { getData: () => clip } });
  fireEvent.change(el, {
    target: { value: `${el.value.slice(0, caret)}${clip}${el.value.slice(caret)}` },
  });
}

/**
 * An MDL V2000 molblock with the given atoms.
 *
 * Written out at the real column offsets rather than approximated, because the element symbol
 * lives at columns 32-34 and a fixture that got that wrong would be testing the fixture. Bonds are
 * omitted — the RDKit fake keys on atom composition and says so.
 *
 * `title` defaults to a non-empty string only because most fixtures read better that way. The
 * **blank** title is the normal case in the wild — `MolToMolBlock`, ChemDraw and most exporters
 * leave line 1 empty — and it is the one every fixture here used to get wrong.
 */
export function molblock(symbols: string[], title = 'stub'): string {
  const zero = (0).toFixed(4).padStart(10, ' ');
  const counts = `${String(symbols.length).padStart(3, ' ')}  0  0  0  0  0  0  0  0999 V2000`;
  const atoms = symbols.map(
    (symbol) => `${zero}${zero}${zero} ${symbol.padEnd(3, ' ')} 0  0  0  0  0  0  0  0  0  0  0  0`,
  );
  return [title, '  stub-suite', '', counts, ...atoms, 'M  END'].join('\n');
}
