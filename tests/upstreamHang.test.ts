// @vitest-environment node
//
// Node, not happy-dom: this drives real sockets against a real `node:http` server.

/**
 * A backend that accepts a request and never answers it must not take `/api` down for good.
 *
 * The BFF bounds two things and, until this, not the third. `UPSTREAM_CONNECT_TIMEOUT_MS` covers an
 * upstream that never accepts the connection. `REQUEST_TIMEOUT_MS` covers a client that never
 * finishes sending — the slowloris `serverLimits.test.ts` closed. Between them sat the case where
 * the request is well-formed, the upstream has taken it, and nothing ever comes back:
 * `upstreamReq.setTimeout(0)` and an agent with `timeout: 0`, both correct for a job stream that is
 * legitimately silent for minutes, applied to every route.
 *
 * Measured before the fix against an upstream that accepts and never answers, with
 * `MAX_UPSTREAM_SOCKETS=4`: four requests claimed the whole pool, two more queued in the agent, and
 * after 10 s — five times the configured request timeout — not one of the six had received a single
 * byte. At the shipped pool of 512 that is every `/api` request including `GET /api/healthz`, and
 * `/readyz` answers 200 throughout because it probes on `agent: false`, so the pod is never taken
 * out of rotation either. One blocked backend worker, and the only recovery is the backend
 * answering or every browser giving up.
 *
 * The bound is on the response *headers* rather than on the response, which is what makes one
 * timeout safe on every route: a turn's header block arrives at once and only its body is slow, so
 * this cannot cut a 600 s turn or a quiet job stream. The number below is small only so a test does
 * not have to wait two minutes; what is under test is that the bound exists and that the pool comes
 * back on its own.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Held open and never answered, so the sockets stay claimed. */
const hung: http.ServerResponse[] = [];

let upstream: http.Server;
let bff: http.Server;
let port = 0;

const UPSTREAM_HEADERS_TIMEOUT_MS = 400;
/** Small enough that a handful of hung requests really is the whole pool. */
const MAX_UPSTREAM_SOCKETS = 2;

/** One GET through the BFF, resolved with its status or the transport error it died of. */
function get(path: string): Promise<{ status: number; ms: number }> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, ms: Date.now() - startedAt }));
    });
    req.on('error', () => resolve({ status: 0, ms: Date.now() - startedAt }));
  });
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    // Accepted, and never answered. No `writeHead`, so not one response header is sent.
    hung.push(res);
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  vi.resetModules();
  process.env.CHEMCLAW_API_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  process.env.UPSTREAM_HEADERS_TIMEOUT_MS = String(UPSTREAM_HEADERS_TIMEOUT_MS);
  process.env.MAX_UPSTREAM_SOCKETS = String(MAX_UPSTREAM_SOCKETS);
  process.env.CLIENT_DIR = '/nonexistent-client-dir';
  const { createBffServer } = await import('../server/app.ts');

  bff = createBffServer();
  await new Promise<void>((resolve) => bff.listen(0, '127.0.0.1', resolve));
  port = (bff.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const res of hung) res.destroy();
  await new Promise<void>((resolve) => bff.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe('an upstream that accepts and never answers', () => {
  it('gives up rather than holding the socket for ever', async () => {
    const answer = await get('/api/jobs');

    // A 502, not a hang. The status matters less than the fact that it arrived at all.
    expect(answer.status).toBe(502);
    expect(answer.ms).toBeLessThan(UPSTREAM_HEADERS_TIMEOUT_MS * 6);
  });

  it('gives the socket pool back, so /api recovers without anyone intervening', async () => {
    // **What the bound buys is recovery, not immunity**, and the first draft of this test asked
    // for the wrong one: while the pool really is full every other request queues behind it, so a
    // `/api/healthz` issued at that moment is refused too. That is not the defect — a saturated
    // pool is a saturated pool. The defect was that it stayed that way for ever.
    const claimed = Promise.all([get('/api/jobs'), get('/api/jobs')]);

    // A request the upstream *would* answer, issued after the hung ones have been let go.
    await claimed;
    const healthy = await get('/api/healthz');

    expect(healthy.status).toBe(200);
  });
});
