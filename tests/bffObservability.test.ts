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
/**
 * The client-event budget this file drives the BFF with.
 *
 * A tenth of the shipped default, so the burst below is 100 requests rather than 3,020 — the
 * shipped number is 200 chemists x 12 flushes a minute plus headroom (`server/config.ts`), and
 * spending it here would make this the slowest test in the suite while proving the same thing.
 */
const CLIENT_EVENT_BUDGET = 80;

let bff: http.Server;
let port = 0;

/** What the upstream was asked for, so "never forwarded" is an assertion and not a hope. */
const upstreamPaths: string[] = [];

/** The correlation id the upstream was *sent*, per request. `undefined` when it was sent none. */
const upstreamCorrelations: (string | undefined)[] = [];

/**
 * Whether the stand-in service stamps a correlation id of its own on the way back.
 *
 * Both answers are real. The Chemclaw service adopts a well-formed inbound id and echoes it, so
 * the two ids are normally the same string; a deployment whose service is older, or an
 * intermediary that mints its own, sends back something different — and something in front of it
 * may send back nothing at all, which is the case that used to log an empty id.
 */
let upstreamStampsCorrelation = true;

/** Flipped by a test to make the upstream's own readiness fail. */
let upstreamReady = true;

/** How long the upstream takes to answer `/readyz`, so a probe storm has something to pile up on. */
let readyzDelayMs = 0;

/** Every line this process wrote while a test ran. */
let lines: string[] = [];

/** Small enough that an oversized body is a few kilobytes rather than a few megabytes. */
const MAX_BODY_BYTES = 4_096;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    upstreamPaths.push(`${req.method} ${req.url}`);
    upstreamCorrelations.push(
      typeof req.headers['x-chemclaw-correlation-id'] === 'string'
        ? req.headers['x-chemclaw-correlation-id']
        : undefined,
    );
    if (req.url?.endsWith('/events')) {
      // The job push-back stream: open for as long as the client wants it, which is what makes an
      // abandoned response testable at all.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(': open\n\n');
      const ping = setInterval(() => res.write(': ping\n\n'), 100);
      res.on('close', () => clearInterval(ping));
      return;
    }
    if (req.url === '/readyz') {
      setTimeout(() => {
        res.writeHead(upstreamReady ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: upstreamReady ? 'ready' : 'database unreachable' }));
      }, readyzDelayMs);
      return;
    }
    // The header the service stamps on every response — the join key this app reads back.
    res.writeHead(200, {
      'content-type': 'application/json',
      ...(upstreamStampsCorrelation ? { 'x-chemclaw-correlation-id': 'corr-from-service' } : {}),
    });
    res.end('{"session_id":"' + 'a'.repeat(32) + '"}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  vi.resetModules();
  process.env.CHEMCLAW_API_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  process.env.CLIENT_DIR = '/nonexistent-client-dir';
  process.env.AUTH_MODE = 'dev';
  process.env.LOG_LEVEL = 'info';
  // Small, and set here rather than left at the default, because what this file asserts about the
  // budget is that the KNOB decides it. `CLIENT_EVENTS_RATE_PER_MIN` had no reader at all — the
  // limit was a module constant of its own — so a deployment that raised it changed nothing, and
  // a test that only drove the constant could not tell the difference.
  process.env.CLIENT_EVENTS_RATE_PER_MIN = String(CLIENT_EVENT_BUDGET);
  // Small, so the oversize-refusal line below is testable without moving two megabytes. Nothing
  // else in this file posts a proxied body at all.
  process.env.MAX_BODY_BYTES = String(MAX_BODY_BYTES);
  const { createBffServer } = await import('../server/app.ts');
  bff = createBffServer();
  await new Promise<void>((resolve) => bff.listen(0, '127.0.0.1', resolve));
  port = (bff.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => bff.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

beforeEach(async () => {
  // Process-wide, like the readiness cache below it: without this, one test spends the budget the
  // next one needs.
  (await import('../server/clientEvents.ts')).resetClientEventBudget();
  lines = [];
  upstreamPaths.length = 0;
  upstreamCorrelations.length = 0;
  upstreamReady = true;
  upstreamStampsCorrelation = true;
  readyzDelayMs = 0;
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

/**
 * The join key, on every line rather than on the lucky ones.
 *
 * It used to be read off the upstream RESPONSE and nowhere else, so it existed only for requests
 * the service answered. Measured on a running BFF: `/healthz`, `/readyz` and `/config.js` all
 * logged `correlation_id: ""` — and so did every 502, 499, 413 and `/api:blocked`, which is the
 * entire population during an outage. That is exactly when somebody is trying to join a browser's
 * `/api/client-events` report to the request that caused it, and the browser stamps its entries
 * with whatever id it was last told (`src/lib/logger.ts`), which during an outage is nothing.
 *
 * `server/proxy.ts` strips every client-supplied `x-chemclaw-*` request header deliberately, so
 * there is no inbound id to trust: the front door mints one. The service adopts a well-formed
 * inbound id (`_request_correlation_id`, `[A-Za-z0-9_-]{8,64}`), which is why the minted shape is
 * a uuid4 hex — sent, adopted, and echoed back as the same string.
 */
describe('the correlation id', () => {
  /** The id on the access line for `route`, or `undefined` if there is no such line. */
  const idFor = (route: string): unknown => accessLine(route)?.correlation_id;

  it('is on the lines that had none: a health check, a block, a refused body', async () => {
    await get('/healthz');
    await get('/api/metrics');
    // A 413, answered here with the upstream never contacted — one of the four statuses that used
    // to log an empty id. The 502 is the same property one hop further out and is asserted where
    // one is actually produced, in `upstreamHang.test.ts`.
    await get('/api/sessions', { method: 'POST', body: 'x'.repeat(MAX_BODY_BYTES * 2) });

    for (const route of ['/healthz', '/api:blocked', '/api/sessions']) {
      expect(idFor(route)).toMatch(/^[0-9a-f]{32}$/);
    }
    // Distinct per request, or it is a process id rather than a request id.
    expect(idFor('/healthz')).not.toBe(idFor('/api:blocked'));
  });

  it('is sent upstream, so both processes record one request under one id', async () => {
    upstreamStampsCorrelation = false;
    await get('/api/sessions', { method: 'POST', body: '{}' });

    const sent = upstreamCorrelations.at(-1);
    expect(sent).toMatch(/^[0-9a-f]{32}$/);
    // The shape the service will ADOPT rather than replace: `[A-Za-z0-9_-]{8,64}`.
    expect(sent).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    // And with the upstream stamping nothing, the id this pod logs is the one it sent — where it
    // used to log `""`.
    expect(idFor('/api/sessions')).toBe(sent);
  });

  it('never carries a client-supplied one upstream', async () => {
    // The strip rule in `server/proxy.ts` is what makes minting honest rather than decorative: a
    // browser must not be able to name itself with a header the system trusts elsewhere.
    await get('/api/sessions', {
      method: 'POST',
      body: '{}',
      headers: { 'x-chemclaw-correlation-id': 'forged-by-the-client' },
    });
    expect(upstreamCorrelations.at(-1)).not.toBe('forged-by-the-client');
    expect(idFor('/api/sessions')).not.toBe('forged-by-the-client');
  });

  it('yields to the service’s own id when the service sends one', async () => {
    // Normally these are the same string, because the service adopts what it was sent. Where they
    // differ, the id the SERVICE wrote into its own records is the one worth quoting.
    const res = await get('/api/sessions', { method: 'POST', body: '{}' });
    expect(idFor('/api/sessions')).toBe('corr-from-service');
    expect(res.headers.get('x-chemclaw-correlation-id')).toBe('corr-from-service');
  });

  it('is on the response, so the browser can report the request that failed', async () => {
    // The other half of the join: `/api/client-events` arrives with whatever id the page was
    // holding, and on a route the service never answered there was nothing to hold.
    for (const path of ['/healthz', '/config.js', '/api/metrics']) {
      const res = await get(path);
      expect(res.headers.get('x-chemclaw-correlation-id')).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('takes no place in the metric labels', async () => {
    // It is per-request and unbounded, which is the definition of a label that must not exist.
    await get('/healthz');
    const id = idFor('/healthz');
    // Asserted first, or the containment below is vacuously true for the empty string this test
    // exists on the other side of.
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(await (await get('/metrics')).text()).not.toContain(String(id));
  });
});

describe('a body over the cap', () => {
  it('is refused with a line naming the route template, not the path the caller chose', async () => {
    const sid = 'd'.repeat(32);
    await get(`/api/sessions/${sid}/messages`, {
      method: 'POST',
      body: 'x'.repeat(MAX_BODY_BYTES * 2),
    });

    const refusal = lines
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as { message?: string; fields?: Record<string, unknown> }];
        } catch {
          return [];
        }
      })
      .find((r) => r.message === 'refused body over cap');

    // Before: `path: req.url`, which is the one string the caller controls entirely, written into
    // a log record on an unauthenticated request. `server/app.ts` already refuses to use it as a
    // metric label for the same reason.
    expect(refusal?.fields).toMatchObject({
      method: 'POST',
      route: '/api/sessions/{id}/messages',
    });
    expect(refusal?.fields).not.toHaveProperty('path');
    expect(JSON.stringify(refusal)).not.toContain(sid);
    expect(refusal?.fields?.correlation_id).toMatch(/^[0-9a-f]{32}$/);
    // Refused here, so the upstream never saw the body at all.
    expect(upstreamPaths).toEqual([]);
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

  it('refuses a batch over the per-minute budget with a 429 the sink can read', async () => {
    // Nothing bounded the RATE at which this unauthenticated route wrote to the pod's log: twenty
    // clients posting maximum-size batches for three seconds had 1,297 accepted, ~24,600 log
    // entries and ~94 MB — about 31 MB/s of node disk and log ingest from anything that can open
    // a socket to the pod.
    const batch = JSON.stringify({ entries: [{ level: 'info', message: 'turn.timing' }] });
    const post = (): Promise<Response> =>
      get('/api/client-events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: batch,
      });

    // Exactly the configured budget is accepted and the overflow is refused, which is the whole
    // claim: the number comes from the configuration, not from this file and not from a constant
    // beside the handler.
    const statuses: number[] = [];
    for (let i = 0; i < (CLIENT_EVENT_BUDGET + 20) / 10; i += 1) {
      statuses.push(...(await Promise.all(Array.from({ length: 10 }, post))).map((r) => r.status));
    }
    expect(statuses.filter((s) => s === 204)).toHaveLength(CLIENT_EVENT_BUDGET);
    expect(statuses.filter((s) => s === 429)).toHaveLength(20);

    // A refusal the browser can act on rather than a reset socket: the sink reads `Retry-After`
    // and backs off by it (`src/lib/logger.ts`), which it cannot do if the connection dies first.
    const refused = await post();
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await refused.json()).toMatchObject({ detail: 'too many client event batches' });

    // And the refusals are already counted, because every response is: no metric of its own.
    const body = await (await get('/metrics')).text();
    expect(body).toContain('route="/api/client-events",method="POST",status="429"');
  }, 30_000);

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

/** `chemclaw_ui_requests_in_flight` right now. */
const inFlight = async (): Promise<number> => {
  const body = await (await get('/metrics')).text();
  return Number(/chemclaw_ui_requests_in_flight (\d+)/.exec(body)?.[1] ?? -1);
};

describe('a response the client walked away from', () => {
  it('still decrements the in-flight gauge and still writes its access line', async () => {
    // The defect, measured on this route because it is the one that matters: the bookkeeping ran
    // on `finish`, which a client abort never reaches. Five aborted `/sessions/{id}/events`
    // streams took the gauge from 1 to 6 and left it at **6 for the life of the process** — a
    // gauge an alert can only ever fire on again — and the access log had **0** lines for the
    // longest-lived, most failure-prone route in this process.
    const before = await inFlight();

    const controllers = Array.from({ length: 5 }, () => new AbortController());
    await Promise.all(
      controllers.map((c) =>
        fetch(`http://127.0.0.1:${port}/api/sessions/${'c'.repeat(32)}/events`, {
          signal: c.signal,
        }).then((r) => {
          // Open the body so the proxy is genuinely streaming when the abort lands.
          void r.body?.getReader().read();
        }),
      ),
    );
    expect(await inFlight()).toBe(before + 5);

    for (const c of controllers) c.abort();
    // The abort has to reach this process; `close` on the response is what the fix listens for.
    await new Promise((r) => setTimeout(r, 250));

    expect(await inFlight()).toBe(before);

    // One line per abandoned stream, and it says so: 499 is the status booked for a response the
    // client left, so "how many streams were abandoned?" is answerable from the scrape rather
    // than being indistinguishable from a served 200.
    const abandoned = lines
      .map((l) => {
        try {
          return JSON.parse(l) as { message?: string; fields?: Record<string, unknown> };
        } catch {
          return null;
        }
      })
      .filter((r) => r?.message === 'request' && r.fields?.route === '/api/sessions/{id}/events');
    expect(abandoned).toHaveLength(5);
    expect(abandoned[0]?.fields).toMatchObject({ status: 499, aborted: true, sent_status: 200 });

    const body = await (await get('/metrics')).text();
    expect(body).toContain('route="/api/sessions/{id}/events",method="GET",status="499"');
  }, 20_000);
});

describe('a readiness storm', () => {
  it('costs one upstream probe however many probes arrive at once', async () => {
    // The cache is written when a probe RESOLVES, so before the single-flight every request that
    // arrived while one was in flight started another: 40 concurrent probes against a 120 ms
    // upstream produced 40 upstream requests. That is a readiness check turning into load on the
    // service it is asking about, during exactly the rolling restart that produced the burst.
    const { clearReadinessCache } = await import('../server/ready.ts');
    clearReadinessCache();
    readyzDelayMs = 120;

    const statuses = await Promise.all(
      Array.from({ length: 40 }, () => get('/readyz').then((r) => r.status)),
    );

    expect(new Set(statuses)).toEqual(new Set([200]));
    expect(upstreamPaths.filter((p) => p === 'GET /readyz')).toHaveLength(1);
  }, 20_000);
});
