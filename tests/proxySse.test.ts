// @vitest-environment node
//
// Node, not the suite's default happy-dom: this drives a real server hop and reads the response
// off a socket, which is the only place the properties below are observable.

/**
 * The proxy's SSE contract, driven end to end.
 *
 * `tests/proxyAuth.test.ts` is excellent for headers going *up*. Nothing drove an event stream
 * coming *down*, so the three things this proxy exists to do to a streaming response —
 * `delete content-length`, `x-accel-buffering: no`, and a heartbeat that never lands mid-frame —
 * were properties of the current implementation rather than a contract. Breaking all three left
 * the whole suite green.
 *
 * This is the defect class `playwright.full-stack.config.ts` names by name — "a Vite proxy that
 * dropped `content-type` on SSE responses" — and its production shape is nastier than a dropped
 * header: keeping `content-length` on a chunked stream, or losing `x-accel-buffering`, makes an
 * nginx or OpenShift ingress buffer the whole turn. The answer then arrives *correct* and all at
 * once at the very end, which looks like a slow model rather than a broken deployment.
 *
 * Every assertion is on bytes read from a socket, with a real upstream on the other side. A unit
 * test of the header block could not see the buffering, and a unit test of `attachHeartbeat` could
 * not see that it is wired to the streaming branch at all.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** What the stand-in upstream should do for the next request. Set per test. */
let respond: (res: http.ServerResponse) => void = (res) => res.end();

let upstream: http.Server;

/** One downstream response, read as it arrives rather than as a whole. */
interface Downstream {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Every chunk, with the offset in ms from the moment the headers landed. */
  chunks: { at: number; text: string }[];
  body: string;
}

/** GET through a proxy on `port`, recording when each chunk arrived. */
function read(port: number, path = '/api/sessions/x/messages'): Promise<Downstream> {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, host: '127.0.0.1', path, method: 'GET' }, (res) => {
      const started = Date.now();
      const chunks: { at: number; text: string }[] = [];
      res.setEncoding('utf8');
      res.on('data', (text: string) => chunks.push({ at: Date.now() - started, text }));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          chunks,
          body: chunks.map((c) => c.text).join(''),
        }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * A proxy server with its own configuration.
 *
 * `server/proxy.ts` reads `cfg` at module scope — the upstream URL and the heartbeat interval both
 * — so a second configuration means a second module instance. `vi.resetModules()` is what makes
 * that possible in a process that has already imported the config.
 */
async function startProxy(env: Record<string, string>, expectSse = true): Promise<number> {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const { proxy } = await import('../server/proxy.ts');
  const { mintCorrelationId } = await import('../server/correlation.ts');
  const server = http.createServer((req, res) =>
    proxy(req, res, req.url?.replace(/^\/api/, '') ?? '/', expectSse, {
      route: '/api/sessions/{id}/events',
      upstreamMs: null,
      correlationId: mintCorrelationId(),
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

const servers: http.Server[] = [];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  upstream = http.createServer((req, res) => respond(res));
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  for (const server of servers) await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
});

const upstreamUrl = (): string => `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

describe('the headers a streaming response is rewritten with', () => {
  let port = 0;

  beforeAll(async () => {
    // Heartbeat off: this block is about the header block, and an injected comment frame would be
    // one more thing in the body for no reason. The heartbeat has its own block below.
    port = await startProxy({ CHEMCLAW_API_URL: upstreamUrl(), SSE_HEARTBEAT_MS: '0' });
  });

  it('drops content-length and opts out of ingress buffering', async () => {
    const body = 'event: token\ndata: {"type":"token","text":"hi"}\n\n';
    respond = (res) => {
      // A `content-length` on an event stream is what a backend that pre-rendered its first frame
      // would send. Forwarding it truncates the stream at that many bytes for any client that
      // honours it, and tells every intermediary the response is complete and safe to buffer.
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'content-length': String(Buffer.byteLength(body)),
      });
      res.end(body);
    };

    const down = await read(port);

    expect(down.status).toBe(200);
    expect(down.headers['content-type']).toContain('text/event-stream');
    expect(down.headers['content-length'], 'a chunked stream has no length').toBeUndefined();
    // The standard opt-out from nginx's (and several cloud ingresses') response buffering. Without
    // it the whole turn is held until it completes — correct output, and completely wrong.
    expect(down.headers['x-accel-buffering']).toBe('no');
    // `no-transform` on top of `no-cache`: a proxy that "optimises" the body is a proxy that
    // reframes it.
    expect(down.headers['cache-control']).toContain('no-transform');
    expect(down.body).toBe(body);
  });

  it('leaves an ordinary JSON response exactly as it was', async () => {
    // The control. Without this the assertions above would pass on a proxy that stripped
    // `content-length` from *everything*, which would be a different bug rather than none.
    const jsonPort = await startProxy(
      { CHEMCLAW_API_URL: upstreamUrl(), SSE_HEARTBEAT_MS: '0' },
      false,
    );
    const body = '{"session_id":"aaaa"}';
    respond = (res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      });
      res.end(body);
    };

    const down = await read(jsonPort, '/api/sessions');

    expect(down.headers['content-length']).toBe(String(Buffer.byteLength(body)));
    expect(down.headers['x-accel-buffering']).toBeUndefined();
  });

  it('forwards frames as they are produced rather than at the end', async () => {
    // The property the whole file exists for, and the only one a header assertion cannot reach: a
    // chain that buffers still delivers every byte, just all at once. So the assertion is on
    // *when* the first frame arrived relative to the last, not on what arrived.
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: token\ndata: {"type":"token","text":"first"}\n\n');
      setTimeout(() => {
        res.write('event: token\ndata: {"type":"token","text":"second"}\n\n');
        res.end();
      }, 250);
    };

    const down = await read(port);

    expect(down.chunks.length).toBeGreaterThan(1);
    expect(down.chunks[0]?.text).toContain('first');
    const last = down.chunks[down.chunks.length - 1];
    // A buffering hop delivers everything in one chunk at the end; the gap is the evidence it did
    // not. Half the upstream's own gap, so this is a claim about buffering rather than a race.
    expect((last?.at ?? 0) - (down.chunks[0]?.at ?? 0)).toBeGreaterThan(120);
  });
});

describe('the heartbeat', () => {
  let port = 0;

  beforeAll(async () => {
    // Deliberately tiny. The shipped default is 15 s and a test that waited for it would be a test
    // nobody runs; what is under test is the *rule* about when it may write, not the interval.
    port = await startProxy({ CHEMCLAW_API_URL: upstreamUrl(), SSE_HEARTBEAT_MS: '60' });
  });

  it('never injects into a frame the client is still assembling', async () => {
    // The invariant `attachHeartbeat` states about itself: `: hb\n\n` is a comment every SSE parser
    // discards, but only if it lands *between* frames. Written into a half-delivered `data:` line
    // it corrupts the frame the client is mid-way through parsing — silently, only after a quiet
    // period longer than the interval, and therefore only in production.
    let finish: (() => void) | null = null;
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // A frame cut mid-value, which is exactly what a TCP split looks like.
      res.write('event: token\ndata: {"type":"token","text":"hi');
      finish = () => {
        res.write('"}\n\n');
        setTimeout(() => res.end(), 260);
      };
    };

    const reading = read(port);
    // Four heartbeat intervals of silence, with the stream parked mid-frame.
    await sleep(260);
    expect(finish, 'the upstream never started').not.toBeNull();
    finish!();

    const down = await reading;

    // Nothing may precede the completion of the frame.
    const beforeClose = down.body.slice(0, down.body.indexOf('"}\n\n'));
    expect(beforeClose, `heartbeat injected mid-frame: ${JSON.stringify(down.body)}`).not.toContain(
      ': hb',
    );
    // And once the frame closed, the quiet period is heartbeaten as advertised — which is what
    // makes the assertion above a statement about *placement* rather than about a heartbeat that
    // never fires at all.
    expect(down.body, 'no heartbeat after the frame closed either').toContain(': hb\n\n');
    // The frame itself survived intact.
    expect(down.body).toContain('event: token\ndata: {"type":"token","text":"hi"}\n\n');
  });

  it('keeps beating when the frame that closed arrived split across chunks', async () => {
    // The boundary check used to read one chunk in isolation: `chunk.subarray(-2)` on a one-byte
    // chunk has length 1, which failed the test and set "mid-frame" — and nothing could clear it,
    // because clearing it needed another chunk and the stream had just gone quiet. So one
    // unluckily-split frame silenced the heartbeat for the life of the stream, after which any
    // fronting router drops the healthy-but-silent connection on its idle timeout. Measured at
    // `SSE_HEARTBEAT_MS=60`: 4 heartbeats when the frame arrived whole, 0 when it arrived split.
    //
    // Both deliveries below are byte-identical on the wire and both are valid SSE. Nothing
    // constrains where the upstream's `send()` calls or the network put a chunk boundary.
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: token\ndata: {"type":"token","text":"hi"}\n');
      // The frame's closing newline, alone. This is the chunk the old check could not read.
      res.write('\n');
      setTimeout(() => res.end(), 260);
    };

    const down = await read(port);

    expect(down.body, 'the heartbeat latched off on a split frame').toContain(': hb\n\n');
    expect(down.body).toContain('event: token\ndata: {"type":"token","text":"hi"}\n\n');
  });

  it('writes only comment frames, never a synthesised event', async () => {
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: token\ndata: {"type":"token","text":"hi"}\n\n');
      setTimeout(() => res.end(), 260);
    };

    const down = await read(port);

    expect(down.body).toContain(': hb\n\n');
    // One `event:` line — the real one. A heartbeat that named an event type would reach
    // `normalizeEvent` and be discarded there, but a client that logged unknown types would fill
    // its console every 15 seconds for every idle stream.
    expect(down.body.match(/^event:/gm)).toHaveLength(1);
  });
});
