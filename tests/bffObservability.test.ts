// @vitest-environment node
//
// Node, not happy-dom: these are properties of what this process writes and answers, and the probe
// is a real request across a real hop.

/**
 * The BFF said nothing about its own traffic.
 *
 * `createRequestListener` handled `/healthz`, `/config.js`, `/api/*` and the static assets and
 * emitted no log line on any success path — the complete inventory was eleven calls, all startup
 * banners or errors. So there was no request rate, no status distribution, no latency, no per-route
 * volume and no upstream error rate: an operator looking at this pod during an incident saw three
 * startup lines and silence, and "is the frontend slow or the backend?" had no answer on this side.
 *
 * Three things are pinned here, and one absence:
 *
 *  - an access line per response, in the service's own JSON shape, keyed on the route PATTERN;
 *  - `/metrics`, whose label set must stay bounded — a per-session label is a new time series per
 *    conversation, and this endpoint is unauthenticated;
 *  - `/readyz`, which actually probes the upstream, unlike `/healthz`, which answers from a string
 *    literal and reported this pod healthy with the Chemclaw service entirely gone;
 *  - and that `/api/client-events` is answered HERE and never forwarded.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

let upstream: http.Server;
let bff: http.Server;
let port = 0;

/** What the upstream was asked for, so "never forwarded" is an assertion and not a hope. */
const upstreamPaths: string[] = [];

/** Flipped by a test to make the upstream's own readiness fail. */
let upstreamReady = true;

/** Every line this process wrote while a test ran. */
let lines: string[] = [];

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    upstreamPaths.push(`${req.method} ${req.url}`);
    if (req.url === '/readyz') {
      res.writeHead(upstreamReady ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: upstreamReady ? 'ready' : 'database unreachable' }));
      return;
    }
    // The header the service stamps on every response — the join key this app reads back.
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-chemclaw-correlation-id': 'corr-from-service',
    });
    res.end('{"session_id":"' + 'a'.repeat(32) + '"}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  vi.resetModules();
  process.env.CHEMCLAW_API_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  process.env.CLIENT_DIR = '/nonexistent-client-dir';
  process.env.AUTH_MODE = 'dev';
  process.env.LOG_LEVEL = 'info';
  const { createBffServer } = await import('../server/app.ts');
  bff = createBffServer();
  await new Promise<void>((resolve) => bff.listen(0, '127.0.0.1', resolve));
  port = (bff.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => bff.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

beforeEach(() => {
  lines = [];
  upstreamPaths.length = 0;
  upstreamReady = true;
  // Both, because the logger splits by severity: warnings and errors go to stderr.
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => void lines.push(String(line)));
});

const get = (path: string, init?: RequestInit): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${path}`, init);

/** The access line for `route`, parsed, or `undefined`. */
const accessLine = (route: string): Record<string, unknown> | undefined => {
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { message?: string; fields?: Record<string, unknown> };
      if (parsed.message === 'request' && parsed.fields?.route === route) return parsed.fields;
    } catch {
      // Not every line is a record — a stray console call is not a failure of this test.
    }
  }
  return undefined;
};

describe('the access log', () => {
  it('writes one JSON line per response, in the field names the service uses', async () => {
    await get('/healthz');
    const fields = accessLine('/healthz');
    expect(fields).toMatchObject({ method: 'GET', status: 200 });
    expect(typeof fields?.duration_ms).toBe('number');
    expect(typeof fields?.bytes).toBe('number');
    // The shape itself, so a log stack parses this beside the service's records rather than
    // guessing at a sentence.
    const record = JSON.parse(
      lines.find((l) => l.includes('"message":"request"')) ?? '{}',
    ) as Record<string, unknown>;
    expect(record.level).toBe('INFO');
    expect(record.logger).toBe('chemclaw3-ui');
    expect(typeof record.time).toBe('string');
  });

  it('names the route PATTERN, never the id-bearing path', async () => {
    const sid = 'a'.repeat(32);
    await get(`/api/sessions/${sid}/messages`, { method: 'POST', body: '{}' });
    expect(accessLine('/api/sessions/{id}/messages')).toBeTruthy();
    // The session id must appear nowhere in the labels: it is what would mint one time series per
    // conversation, and it is in the URL of every interesting request this process serves.
    expect(lines.filter((l) => l.includes('"message":"request"')).join('\n')).not.toContain(sid);
  });

  it('carries the upstream duration and the service’s own correlation id', async () => {
    await get('/api/sessions', { method: 'POST', body: '{}' });
    const fields = accessLine('/api/sessions');
    expect(fields?.correlation_id).toBe('corr-from-service');
    expect(typeof fields?.upstream_ms).toBe('number');
  });

  it('buckets an un-whitelisted path rather than labelling with it', async () => {
    // An un-whitelisted path is attacker-chosen. Labelling with it would let anyone mint time
    // series in this process.
    await get('/api/metrics');
    expect(accessLine('/api:blocked')).toMatchObject({ status: 404 });
  });
});

describe('/metrics', () => {
  it('exposes a request count and a duration histogram for this pod', async () => {
    await get('/healthz');
    const body = await (await get('/metrics')).text();
    expect(body).toContain(
      'chemclaw_ui_requests_total{route="/healthz",method="GET",status="200"}',
    );
    expect(body).toContain('chemclaw_ui_request_duration_seconds_bucket');
    expect(body).toContain('chemclaw_ui_requests_in_flight');
  });

  it('takes no session, actor or correlation id as a label', async () => {
    const sid = 'b'.repeat(32);
    await get(`/api/sessions/${sid}/messages`, { method: 'POST', body: '{}' });
    const body = await (await get('/metrics')).text();
    expect(body).toContain('route="/api/sessions/{id}/messages"');
    expect(body).not.toContain(sid);
    expect(body).not.toContain('corr-from-service');
  });

  it('is this pod’s own, and does not open a path to the service’s', async () => {
    // `/api/metrics` is deliberately not whitelisted; the container test in `delivery.test.ts`
    // asserts the same thing from the other side.
    expect((await get('/api/metrics')).status).toBe(404);
    expect(upstreamPaths).toEqual([]);
  });
});

describe('/readyz', () => {
  it('is ready when the upstream is', async () => {
    const res = await get('/readyz');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ready' });
    expect(upstreamPaths).toContain('GET /readyz');
  });

  it('is NOT ready when the upstream is not — which /healthz cannot tell you', async () => {
    // The whole defect: `/healthz` answers `{"status":"ok"}` from a string literal, so this pod
    // reported healthy with the service entirely gone. Liveness stays that way deliberately;
    // readiness is this route.
    upstreamReady = false;
    // The probe is cached for a few seconds — deliberately, so a probe every second from every
    // replica does not become load of its own — so the cache is cleared rather than waited out.
    const { clearReadinessCache } = await import('../server/ready.ts');
    clearReadinessCache();
    const res = await get('/readyz');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'degraded', upstream_status: 503 });

    // And liveness is unmoved, which is the point of having both.
    expect((await get('/healthz')).status).toBe(200);
  });
});

describe('/api/client-events', () => {
  it('writes the browser’s batch into this pod’s log, marked as the browser’s', async () => {
    const res = await get('/api/client-events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        app_version: '1.2.3',
        user_agent: 'test-agent',
        entries: [
          {
            level: 'error',
            message: 'render.failed',
            correlationId: 'corr-1',
            sessionId: 'sess-1',
            ts: '2026-08-27T00:00:00.000Z',
            context: { name: 'TypeError' },
          },
        ],
      }),
    });
    expect(res.status).toBe(204);

    const record = lines
      .map((l) => {
        try {
          return JSON.parse(l) as { message?: string; fields?: Record<string, unknown> };
        } catch {
          return null;
        }
      })
      .find((r) => r?.message === 'render.failed');
    expect(record?.fields).toMatchObject({
      source: 'browser',
      correlation_id: 'corr-1',
      session_id: 'sess-1',
      app_version: '1.2.3',
    });
    // Never proxied: the service has no such route, and this list is what proves it was not tried.
    expect(upstreamPaths).toEqual([]);
  });

  it('cannot forge a second log line out of a message full of newlines', async () => {
    await get('/api/client-events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entries: [{ level: 'error', message: 'a\n{"level":"ERROR","message":"forged"}' }],
      }),
    });
    // One line, and the forged object is a value inside it rather than a record beside it.
    expect(lines.filter((l) => l.includes('forged'))).toHaveLength(1);
    expect(lines.find((l) => l.includes('forged'))?.includes('\n')).toBe(false);
  });

  it('refuses anything but a POST, and refuses a body it will not carry', async () => {
    expect((await get('/api/client-events')).status).toBe(405);
    const big = await get('/api/client-events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: [{ level: 'info', message: 'x'.repeat(70_000) }] }),
    });
    expect(big.status).toBe(413);
  });
});
