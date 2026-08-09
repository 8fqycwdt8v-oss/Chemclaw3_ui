/**
 * The proxy, against real sockets.
 *
 * `server/proxy.ts` had no test at all — it was the only server module `tests/routes.test.ts` did
 * not reach — and review found four defects in it that a unit test would have caught immediately.
 * These start real HTTP servers rather than stubbing, because every one of those defects was about
 * socket behaviour: which bytes reach the peer, and when the connection dies.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Start a server on an ephemeral port and return it with its URL parts. */
async function listen(
  handler: http.RequestListener,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

const close = (server: http.Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

/**
 * Load `proxy.ts` fresh against a given upstream.
 *
 * `vi.resetModules()` rather than a cache-busting import query: `config.ts` reads `process.env` at
 * module scope and `proxy.ts` memoises both the parsed upstream URL and its keep-alive agent, so
 * each test needs its own instance of the whole chain or the first test's backend wins for all of
 * them.
 */
async function loadProxy(upstreamPort: number, env: Record<string, string> = {}) {
  process.env.CHEMCLAW_API_URL = `http://127.0.0.1:${upstreamPort}`;
  process.env.AUTH_MODE = 'dev';
  process.env.BIND_HOST = '127.0.0.1';
  process.env.MAX_BODY_BYTES = env.MAX_BODY_BYTES ?? '4000000';
  vi.resetModules();
  return await import('../server/proxy.ts');
}

interface Fetched {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  error?: string;
}

function call(port: number, options: http.RequestOptions = {}, body?: string): Promise<Fetched> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/x', ...options }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
      );
    });
    req.on('error', (err: NodeJS.ErrnoException) =>
      resolve({ status: 0, headers: {}, body: '', error: err.code }),
    );
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let servers: http.Server[] = [];
beforeEach(() => {
  servers = [];
});
afterEach(async () => {
  for (const server of servers) await close(server);
});

describe('response headers', () => {
  it('forwards the ones a client cannot work without', async () => {
    const upstream = await listen((_q, r) => {
      r.writeHead(401, {
        'content-type': 'application/json',
        // Each of these was dropped by the first allow-list, and each breaks a real path.
        'www-authenticate': 'Bearer error="invalid_token", error_description="expired"',
        location: '/somewhere',
        allow: 'GET, POST',
        'x-powered-by': 'should-not-leak',
        server: 'should-not-leak',
        'set-cookie': 'should-not-leak=1',
      });
      r.end('{}');
    });
    servers.push(upstream.server);

    const { proxy } = await loadProxy(upstream.port);
    const bff = await listen((q, r) => proxy(q, r, '/whatever', false));
    servers.push(bff.server);

    const res = await call(bff.port);
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
    expect(res.headers.location).toBe('/somewhere');
    expect(res.headers.allow).toBe('GET, POST');
    // The allow-list still does its job on the things that should not cross.
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers.server).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('forwarded headers', () => {
  it('appends to x-forwarded-for instead of replacing the client address', async () => {
    // Overwriting substituted OUR peer — the ingress — for the real client, destroying the only
    // record of who made the request while looking authoritative.
    let seen: http.IncomingHttpHeaders = {};
    const upstream = await listen((q, r) => {
      seen = q.headers;
      r.writeHead(200, { 'content-type': 'application/json' });
      r.end('{}');
    });
    servers.push(upstream.server);

    const { proxy } = await loadProxy(upstream.port);
    const bff = await listen((q, r) => proxy(q, r, '/whatever', false));
    servers.push(bff.server);

    await call(bff.port, {
      headers: { 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https' },
    });

    expect(String(seen['x-forwarded-for'])).toContain('203.0.113.7');
    expect(String(seen['x-forwarded-for'])).toContain('127.0.0.1');
    // The scheme the CLIENT used, not the leg we made to a plain-HTTP backend.
    expect(seen['x-forwarded-proto']).toBe('https');
  });

  it('still refuses headers the backend has no business seeing', async () => {
    let seen: http.IncomingHttpHeaders = {};
    const upstream = await listen((q, r) => {
      seen = q.headers;
      r.writeHead(200, { 'content-type': 'application/json' });
      r.end('{}');
    });
    servers.push(upstream.server);

    const { proxy } = await loadProxy(upstream.port);
    const bff = await listen((q, r) => proxy(q, r, '/whatever', false));
    servers.push(bff.server);

    await call(bff.port, { headers: { cookie: 'session=secret', 'x-invented': 'nope' } });
    expect(seen.cookie).toBeUndefined();
    expect(seen['x-invented']).toBeUndefined();
  });
});

describe('the body cap', () => {
  it('answers 413 without resetting the connection the client is uploading on', async () => {
    // The failure this pins: destroying the request socket in the same tick as the response means
    // a browser discards the 413 it had already received and reports a network error instead —
    // the opposite diagnosis for a file that was merely too large.
    const upstream = await listen((q, r) => {
      q.resume();
      q.on('end', () => {
        r.writeHead(200, { 'content-type': 'application/json' });
        r.end('{"ok":true}');
      });
    });
    servers.push(upstream.server);

    const { proxy } = await loadProxy(upstream.port, { MAX_BODY_BYTES: '1000' });
    const bff = await listen((q, r) => proxy(q, r, '/whatever', false));
    servers.push(bff.server);

    const res = await call(bff.port, { method: 'POST' }, 'a'.repeat(50_000));
    expect(res.status).toBe(413);
    expect(res.body).toContain('exceeds');
    expect(res.error).toBeUndefined();
  });

  it('lets a body under the cap through untouched', async () => {
    let received = '';
    const upstream = await listen((q, r) => {
      q.on('data', (c) => (received += c));
      q.on('end', () => {
        r.writeHead(200, { 'content-type': 'application/json' });
        r.end('{"ok":true}');
      });
    });
    servers.push(upstream.server);

    const { proxy } = await loadProxy(upstream.port, { MAX_BODY_BYTES: '1000' });
    const bff = await listen((q, r) => proxy(q, r, '/whatever', false));
    servers.push(bff.server);

    const res = await call(bff.port, { method: 'POST' }, 'b'.repeat(500));
    expect(res.status).toBe(200);
    expect(received).toHaveLength(500);
  });
});

describe('the connection-reset replay', () => {
  it('retries a GET once when the pooled socket was already dead', async () => {
    // The live-verified failure: a request landing on a keep-alive socket the upstream had closed
    // returns ECONNRESET, and the caller sees 502 for a perfectly healthy backend.
    let hits = 0;
    const upstream = await listen((q, r) => {
      hits += 1;
      if (hits === 1) {
        q.socket.destroy();
        return;
      }
      r.writeHead(200, { 'content-type': 'application/json' });
      r.end(`{"hits":${hits}}`);
    });
    servers.push(upstream.server);

    const { proxy } = await loadProxy(upstream.port);
    const bff = await listen((q, r) => proxy(q, r, '/whatever', false));
    servers.push(bff.server);

    const res = await call(bff.port);
    expect(res.status).toBe(200);
    expect(res.body).toContain('"hits":2');
  });

  it('does not retry a POST, which is not safe to replay', async () => {
    // Replaying a turn double-spends its budget or collides with the per-session lock — the same
    // reasoning that makes `streamTurn` refuse to auto-retry.
    let hits = 0;
    const upstream = await listen((q) => {
      hits += 1;
      q.socket.destroy();
    });
    servers.push(upstream.server);

    const { proxy } = await loadProxy(upstream.port);
    const bff = await listen((q, r) => proxy(q, r, '/whatever', false));
    servers.push(bff.server);

    const res = await call(bff.port, { method: 'POST' }, '{}');
    expect(res.status).toBe(502);
    expect(hits).toBe(1);
  });
});
