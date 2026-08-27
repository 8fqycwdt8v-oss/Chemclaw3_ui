/**
 * The reference a support conversation is built on, on every path that has one.
 *
 * The service mints one correlation id per turn and stamps it on every JSON log record it writes,
 * so the join key has always existed on that side. This app could see it in exactly one place — an
 * in-stream `error` event — which meant no id for any HTTP-level failure (401, 404, 409, 422, 429,
 * 503), none for a network drop or a mid-stream disconnect, and, worst of the three, **none at all
 * for a turn that succeeded**: "the answer it gave me at 14:32 cited the wrong note" had no
 * reference whatsoever.
 *
 * The fix is read-back rather than send: the BFF strips every `x-chemclaw-*` request header
 * deliberately and the service has no reader for one, so the id is the service's to issue and this
 * app's to quote.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { streamTurn } from '../src/api/streamTurn.ts';
import { api } from '../src/api/client.ts';
import { ApiError, correlationFrom, errorFromStatus, readFailure } from '../src/api/errors.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import { sendMessage } from '../src/state/sendMessage.ts';
import { TracePanel } from '../src/components/TracePanel.tsx';
import type { AuthProvider } from '../src/auth/types.ts';
import { answerEvent, sseFrames, stubFetch } from './helpers.ts';

const SESSION = 'a'.repeat(32);
const HEADER = 'x-chemclaw-correlation-id';

const devAuth: AuthProvider = {
  mode: 'dev',
  account: null,
  getAccessToken: async () => null,
  login: async () => undefined,
  logout: async () => undefined,
  handleUnauthorized: async () => false,
};

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  // `globals` is off in this project's vitest config, so testing-library's automatic cleanup
  // hook is not registered — without this every render in the file stays in the document.
  cleanup();
});

const sseWith = (body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });

describe('errorFromStatus', () => {
  it('carries the id it is given onto every status it knows', () => {
    for (const status of [401, 404, 409, 422, 429, 503, 500]) {
      // Fourth argument: the third is the response's `Retry-After`, which splits the two 429s.
      expect(errorFromStatus(status, undefined, null, 'corr-1').correlationId).toBe('corr-1');
    }
  });

  it('is empty rather than invented when the service sent none', () => {
    expect(errorFromStatus(503).correlationId).toBe('');
  });
});

describe('reading the id back off a response', () => {
  it('prefers the header, which is present even on a body-less response', async () => {
    const res = new Response(null, { status: 503, headers: { [HEADER]: 'from-header' } });
    expect(correlationFrom(res)).toBe('from-header');
    expect(await readFailure(res)).toEqual({ correlationId: 'from-header', detail: undefined });
  });

  it('falls back to the error body when there is no header', async () => {
    const res = new Response(JSON.stringify({ detail: 'nope', correlation_id: 'from-body' }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    });
    expect(await readFailure(res)).toEqual({ detail: 'nope', correlationId: 'from-body' });
  });

  it('survives a body that is not JSON at all — a gateway page, or nothing', async () => {
    const res = new Response('<html>502</html>', { status: 502, headers: { [HEADER]: 'x' } });
    expect(await readFailure(res)).toEqual({ correlationId: 'x' });
  });
});

describe('a non-streaming call', () => {
  it('puts the id on the typed error, so every banner can quote one', async () => {
    const stub = stubFetch(
      () =>
        new Response(JSON.stringify({ detail: 'a turn is already running' }), {
          status: 409,
          headers: { 'content-type': 'application/json', [HEADER]: 'corr-409' },
        }),
    );
    restore = stub.restore;

    await expect(api.getPlan(SESSION, async () => null)).rejects.toMatchObject({
      kind: 'turn_in_flight',
      correlationId: 'corr-409',
    });
  });
});

describe('a turn', () => {
  it('reports the id from the response header before a single frame arrives', async () => {
    const seen: string[] = [];
    const stub = stubFetch(() =>
      sseWith(sseFrames([answerEvent({ text: 'ok' })]), { [HEADER]: 'corr-header' }),
    );
    restore = stub.restore;

    await streamTurn({
      sessionId: SESSION,
      message: 'hi',
      signal: new AbortController().signal,
      getToken: async () => null,
      onEvent: () => {},
      onCorrelationId: (id) => seen.push(id),
    });

    expect(seen).toEqual(['corr-header']);
  });

  it('takes it from any frame that carries one, so a `turn_started` needs no contract change', async () => {
    // `normalizeEvent` drops an event type it does not know, which is what makes an older frontend
    // survive a newer service. The id is read BEFORE that, off the raw frame, so a frame this
    // build cannot render still hands over the one field support needs — and nothing waits for it.
    const seen: string[] = [];
    const body =
      'event: turn_started\ndata: {"type":"turn_started","correlation_id":"corr-frame"}\n\n' +
      sseFrames([answerEvent({ text: 'ok' })]);
    const stub = stubFetch(() => sseWith(body));
    restore = stub.restore;

    const dropped: string[] = [];
    await streamTurn({
      sessionId: SESSION,
      message: 'hi',
      signal: new AbortController().signal,
      getToken: async () => null,
      onEvent: () => {},
      onCorrelationId: (id) => seen.push(id),
      onFrameDropped: (d) => dropped.push(d.type),
    });

    expect(seen).toEqual(['corr-frame']);
    // And it is not counted as a version skew: a frame we could read the id out of is a frame we
    // understood enough of.
    expect(dropped).toEqual([]);
  });

  it('quotes it on a failure that arrived as a status rather than as an event', async () => {
    const stub = stubFetch((url) => {
      if (url.endsWith('/sessions')) {
        return new Response(JSON.stringify({ session_id: SESSION }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ detail: 'at capacity' }), {
        status: 503,
        headers: { 'content-type': 'application/json', [HEADER]: 'corr-503' },
      });
    });
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    await sendMessage({ conversationId: cid, text: 'pKa?', auth: devAuth });

    expect(useChatStore.getState().banner?.text).toContain('(reference corr-503)');
  });

  it('records it on a turn that SUCCEEDED — the case that had no reference at all', async () => {
    const stub = stubFetch((url) => {
      if (url.endsWith('/sessions')) {
        return new Response(JSON.stringify({ session_id: SESSION }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return sseWith(sseFrames([answerEvent({ text: 'Acetic acid: 4.76.' })]), {
        [HEADER]: 'corr-ok',
      });
    });
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    await sendMessage({ conversationId: cid, text: 'pKa?', auth: devAuth });

    const message = useChatStore.getState().conversations[cid]?.messages.at(-1);
    expect(message?.role === 'assistant' && message.correlationId).toBe('corr-ok');
    expect(message?.role === 'assistant' && message.status).toBe('done');
  });
});

describe('the trace panel footer', () => {
  it('shows the reference, where it can be selected and copied', () => {
    // Scoped queries rather than `screen`: this suite renders several panels and the global
    // screen would find every one of their triggers.
    const view = render(
      <TracePanel
        trace={[{ id: 't1', at: 0, kind: 'plan', plan: { todos: ['do the thing'] } }]}
        correlationId="corr-shown"
      />,
    );
    // The panel is collapsed by default and Radix does not render its content until it opens, so
    // the footer sits behind the same disclosure as the rest of the working.
    fireEvent.click(view.getByRole('button', { name: /Show the agent/ }));
    expect(view.getByText(/Reference corr-shown/)).toBeTruthy();
  });

  it('shows nothing when the service sent none, rather than an empty label', () => {
    const view = render(
      <TracePanel trace={[{ id: 't1', at: 0, kind: 'plan', plan: { todos: ['x'] } }]} />,
    );
    fireEvent.click(view.getByRole('button', { name: /Show the agent/ }));
    expect(view.queryByText(/Reference/)).toBeNull();
  });
});

describe('ApiError', () => {
  it('defaults the id to empty, so a caller that has none says nothing', () => {
    expect(new ApiError('network', 'x').correlationId).toBe('');
  });
});
