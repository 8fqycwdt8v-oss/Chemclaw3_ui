// @vitest-environment node
//
// Node, not happy-dom: the probe is a real request across a real hop to a stub upstream.

/**
 * The BFF's upstream-posture probe.
 *
 * The BFF performs no auth of its own — it forwards the browser's bearer verbatim, which is
 * correct (no confused deputy). The consequence is that `CHEMCLAW_ENTRA_REQUIRED=true` on the
 * *backend* is the only control, and a UI in `msal` mode pointed at a backend still in its dev
 * posture serves everyone anonymously with nothing in this process able to tell. Readiness closes
 * that blind spot: in `msal` mode it issues a credential-less `GET /sessions` — a route that must
 * be authenticated — and treats any answer other than 401/403 as "the backend stopped being an
 * auth boundary", reporting the pod unready so a load balancer pulls it from rotation.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** How the stub upstream should answer `GET /sessions` for the current test. */
let sessionsStatus = 401;
/** How it should answer `GET /readyz`. */
let readyzStatus = 200;
/** Everything the upstream was asked for, so "arrived with no credential" is assertable. */
const seen: { path: string; auth: string | undefined }[] = [];

const upstream = http.createServer((req, res) => {
  seen.push({ path: req.url ?? '', auth: req.headers.authorization });
  const status = req.url === '/readyz' ? readyzStatus : sessionsStatus;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end('{}');
});

let upstreamPort = 0;

beforeEach(async () => {
  if (upstreamPort === 0) {
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as AddressInfo).port;
  }
  seen.length = 0;
  sessionsStatus = 401;
  readyzStatus = 200;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

/** Fresh `readiness()` under the given auth mode, with the cache cleared. */
async function readinessUnder(mode: 'dev' | 'msal') {
  vi.resetModules();
  vi.stubEnv('AUTH_MODE', mode);
  vi.stubEnv('CHEMCLAW_API_URL', `http://127.0.0.1:${upstreamPort}`);
  const { readiness, clearReadinessCache } = await import('../server/ready.ts');
  clearReadinessCache();
  return readiness();
}

describe('msal mode', () => {
  it('is ready when the backend refuses an anonymous /sessions with 401', async () => {
    sessionsStatus = 401;
    const state = await readinessUnder('msal');

    expect(state.ready).toBe(true);
    // The auth probe really did go, and it carried no Authorization header — that is the whole
    // point: it must arrive as an anonymous caller to learn whether one is accepted.
    const sessionsProbe = seen.find((r) => r.path === '/sessions');
    expect(sessionsProbe).toBeDefined();
    expect(sessionsProbe?.auth).toBeUndefined();
  });

  it('is ready when the backend refuses with 403', async () => {
    sessionsStatus = 403;
    expect((await readinessUnder('msal')).ready).toBe(true);
  });

  it('is UNREADY when the backend serves an anonymous /sessions with 200', async () => {
    // The verified vulnerability: an msal UI against a dev-posture backend answered 200 to a
    // request with no token. That is the pod refusing to be ready now.
    sessionsStatus = 200;
    const state = await readinessUnder('msal');

    expect(state.ready).toBe(false);
    expect(state.detail).toBe('upstream accepts anonymous');
  });

  it('does not reach the auth probe when the backend is not even ready', async () => {
    readyzStatus = 503;
    const state = await readinessUnder('msal');

    expect(state.ready).toBe(false);
    expect(state.detail).toBe('upstream not ready');
    // No point asking about auth posture on a backend that cannot serve.
    expect(seen.some((r) => r.path === '/sessions')).toBe(false);
  });
});

describe('dev mode', () => {
  it('never runs the auth-posture probe — dev is anonymous by design', async () => {
    sessionsStatus = 200;
    const state = await readinessUnder('dev');

    expect(state.ready).toBe(true);
    expect(seen.some((r) => r.path === '/sessions')).toBe(false);
  });
});
