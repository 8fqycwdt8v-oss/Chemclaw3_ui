// @vitest-environment node
//
// Node, not happy-dom: this holds real sockets open against a real `node:http` server, which is
// the only way the defect below is visible at all.

/**
 * What long-lived SSE streams may do to everything else this process proxies.
 *
 * The BFF held **one** `http.Agent` for the SSE routes and every ordinary call alike, which put a
 * *residency* limit and a *burst* limit on one number — and the residents win, because an SSE
 * socket is released only when the tab closes. `src/hooks/useJobStreams.ts` opens three streams per
 * tab and holds them for the life of the page, so 200 chemists want 600 sockets against a pool of
 * 512.
 *
 * Measured on the shipped build against a stub upstream that holds streams open: the pool filled at
 * exactly `maxSockets` (`{"status":"ok","open":512}` from the stub) and with it full an ordinary
 * `GET /api/healthz` **never answered** — `curl: (28) Operation timed out after 20002 ms with 0
 * bytes received`. Node's agent queue has no timeout of its own, so the wait was not long, it was
 * unbounded; the queued requests included `POST /sessions/{id}/messages`, the turn itself. The wall
 * was ~170 users per pod, and past it the pod was dead for everyone until the tabs closed.
 *
 * Nothing could have caught that from this suite, because every existing test asks a question and
 * reads the answer. This one keeps sockets, which is the property that broke.
 *
 * Two behaviours are asserted, and the second exists because the first is not sufficient. Splitting
 * the pools stops streams from starving ordinary calls; it does not stop the *stream* pool from
 * filling, and a full pool that hangs for ever is the same outage one route further in. So a
 * request whose pool has nothing free is refused, with a status the SPA's own retry paths already
 * pace themselves on.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Small enough for a test to fill, and the point of the knob: it is a ceiling, whatever its value. */
const STREAM_SOCKETS = 8;
const QUEUE_TIMEOUT_MS = 400;

let upstream: http.Server;
let bff: http.Server;
let port = 0;

/** Streams the stub upstream is currently holding open — the `open: 512` of the measurement. */
let openStreams = 0;

/** Everything this test opened, so nothing is left holding a socket into the next file. */
const opened: AbortController[] = [];

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url?.startsWith('/healthz')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', open: openStreams }));
      return;
    }
    // Everything else is an event stream that never ends — the job push-back stream, exactly as a
    // healthy but silent one behaves.
    openStreams += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(': open\n\n');
    req.on('close', () => {
      openStreams -= 1;
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  vi.resetModules();
  process.env.CHEMCLAW_API_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  process.env.MAX_UPSTREAM_STREAM_SOCKETS = String(STREAM_SOCKETS);
  process.env.UPSTREAM_QUEUE_TIMEOUT_MS = String(QUEUE_TIMEOUT_MS);
  process.env.CLIENT_DIR = '/nonexistent-client-dir';
  const { createBffServer } = await import('../server/app.ts');

  bff = createBffServer();
  await new Promise<void>((resolve) => bff.listen(0, '127.0.0.1', resolve));
  port = (bff.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const controller of opened) controller.abort();
  await new Promise<void>((resolve) => bff.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

/**
 * Open one job push-back stream and hold it, the way a tab does.
 *
 * The body is read but never drained to completion, so the socket stays claimed — which is the
 * whole mechanism. The session id is 32 hex characters because that is what `server/routes.ts`
 * will forward.
 */
async function holdStream(index: number): Promise<number> {
  const controller = new AbortController();
  opened.push(controller);
  const id = index.toString(16).padStart(32, '0');
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/events`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (res.status === 200) void res.body?.getReader().read();
  else await res.text();
  return res.status;
}

/** `GET /api/healthz` through the proxy — an ordinary call, on the ordinary pool. */
async function healthz(timeoutMs: number): Promise<number | 'TIMED OUT'> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.text();
    return res.status;
  } catch {
    return 'TIMED OUT';
  }
}

describe('a pool full of held SSE streams', () => {
  it('does not starve an ordinary request', async () => {
    const statuses = await Promise.all(
      Array.from({ length: STREAM_SOCKETS }, (_, i) => holdStream(i)),
    );
    expect(statuses).toEqual(Array.from({ length: STREAM_SOCKETS }, () => 200));

    // With one shared pool this timed out with zero bytes and stayed that way for as long as the
    // streams were held. It is generous relative to a 2 ms answer and tight relative to "never".
    expect(await healthz(5_000)).toBe(200);
  }, 20_000);

  it('refuses the stream that does not fit rather than queueing it for ever', async () => {
    // The pool is full from the test above; this one has nowhere to go.
    const started = Date.now();
    const status = await holdStream(0xf0);
    const waited = Date.now() - started;

    // Before: no status at all, because `http.Agent`'s queue is untimed and an SSE socket comes
    // back only when a tab closes.
    expect(status).toBe(503);
    expect(waited).toBeGreaterThanOrEqual(QUEUE_TIMEOUT_MS);
    // And an ordinary call is still unaffected while that is happening.
    expect(await healthz(5_000)).toBe(200);
  }, 20_000);
});
