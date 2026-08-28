// @vitest-environment node
//
// Node, not the suite's default happy-dom: this exercises a *server* hop, and happy-dom applies
// the browser's same-origin policy to `fetch`, which refuses the cross-port request to the proxy
// under test before a byte is sent.

/**
 * The BFF forwards the credential and drops the things that would create a second one.
 *
 * The backend performs the whole of authentication — RS256 signature, audience, issuer — so the
 * only thing this process must get right is *not interfering*: the `Authorization` header has to
 * arrive at the upstream byte for byte, and nothing that could authenticate a request by another
 * route (a cookie) may travel with it. Both were true and neither was asserted, which made them
 * a property of the current implementation rather than a contract.
 *
 * Driven against a real `node:http` server standing in for the Chemclaw service, because the thing
 * under test is header handling across a hop — the one thing a unit test of `buildUpstreamHeaders`
 * could not observe, since that function is not exported and the hop is where the copying happens.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Every request the stand-in upstream received, so the test can assert on what arrived. */
const received: http.IncomingHttpHeaders[] = [];

let upstream: http.Server;
let proxyServer: http.Server;
let proxyPort = 0;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    received.push(req.headers);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"session_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  // The proxy reads its target once, at module scope, so the environment has to be set before the
  // import — and the import has to be fresh for each configuration. `vi.resetModules` is what
  // makes that possible in a suite that has already imported the config elsewhere.
  vi.resetModules();
  process.env.CHEMCLAW_API_URL = `http://127.0.0.1:${upstreamPort}`;
  const { proxy } = await import('../server/proxy.ts');

  proxyServer = http.createServer((req, res) => proxy(req, res, '/sessions', false));
  await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
  proxyPort = (proxyServer.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

/** POST through the proxy and return the headers the upstream saw for that request. */
const post = async (headers: Record<string, string>): Promise<http.IncomingHttpHeaders> => {
  received.length = 0;
  await fetch(`http://127.0.0.1:${proxyPort}/api/sessions`, { method: 'POST', headers });
  expect(received).toHaveLength(1);
  return received[0] as http.IncomingHttpHeaders;
};

describe('what reaches the Chemclaw service', () => {
  it('forwards the bearer token verbatim', async () => {
    // A realistic JWT shape: three base64url segments. Forwarding must not touch it — the backend
    // verifies a signature over these exact bytes, so any normalisation invalidates the token.
    const token = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImsxIn0.eyJvaWQiOiJ1LTEifQ.c2lnbmF0dXJl';
    const upstreamHeaders = await post({ authorization: `Bearer ${token}` });

    expect(upstreamHeaders.authorization).toBe(`Bearer ${token}`);
  });

  it('drops cookies, so there is no second way to authenticate and no CSRF surface', async () => {
    const upstreamHeaders = await post({
      authorization: 'Bearer t',
      cookie: 'session=forged; other=1',
    });

    expect(upstreamHeaders.authorization).toBe('Bearer t');
    // The backend sets `allow_credentials=false` and uses no cookies at all. Not forwarding them
    // keeps it that way: a request that could authenticate by cookie is a request a cross-site
    // form could make on the user's behalf.
    expect(upstreamHeaders.cookie).toBeUndefined();
  });

  it('drops proxy-authorization, which is a hop credential and not the caller ', async () => {
    const upstreamHeaders = await post({
      authorization: 'Bearer t',
      'proxy-authorization': 'Basic bm90LXlvdXJz',
    });

    expect(upstreamHeaders.authorization).toBe('Bearer t');
    expect(upstreamHeaders['proxy-authorization']).toBeUndefined();
  });

  it("drops the service's own X-Chemclaw-* headers, which a browser has no business setting", async () => {
    const upstreamHeaders = await post({
      authorization: 'Bearer t',
      'x-chemclaw-actor': 'somebody-else',
      'x-chemclaw-session': 'not-mine',
      'x-chemclaw-dry-run': 'true',
    });

    // Not a live hole and that is exactly why it is worth closing now: the front door derives the
    // actor from the validated bearer token, and these headers are stamped by the service on its
    // way OUT to a connector. What this removes is the trap — a header arriving from a browser
    // under a name the system trusts elsewhere, waiting for the first reader that assumes it did
    // not come from outside.
    expect(upstreamHeaders.authorization).toBe('Bearer t');
    expect(upstreamHeaders['x-chemclaw-actor']).toBeUndefined();
    expect(upstreamHeaders['x-chemclaw-session']).toBeUndefined();
    expect(upstreamHeaders['x-chemclaw-dry-run']).toBeUndefined();
  });

  it('drops the X-Forwarded family, which a browser can set to spoof the edge', async () => {
    const upstreamHeaders = await post({
      authorization: 'Bearer t',
      'x-forwarded-for': '10.0.0.9',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
      'x-real-ip': '10.0.0.9',
      'x-original-url': '/admin',
      'x-rewrite-url': '/admin',
      'x-http-method-override': 'DELETE',
      forwarded: 'for=10.0.0.9;host=evil.example',
    });

    // Every one of these is browser-settable, and some upstream configurations trust them:
    // uvicorn honours X-Forwarded-For/Forwarded under --proxy-headers, and the URL/method
    // overrides smuggle a different path or verb past a gateway's routing and authz. The BFF is
    // the trust boundary, so none of them reach the backend.
    expect(upstreamHeaders.authorization).toBe('Bearer t');
    expect(upstreamHeaders['x-forwarded-for']).toBeUndefined();
    expect(upstreamHeaders['x-forwarded-host']).toBeUndefined();
    expect(upstreamHeaders['x-forwarded-proto']).toBeUndefined();
    expect(upstreamHeaders['x-real-ip']).toBeUndefined();
    expect(upstreamHeaders['x-original-url']).toBeUndefined();
    expect(upstreamHeaders['x-rewrite-url']).toBeUndefined();
    expect(upstreamHeaders['x-http-method-override']).toBeUndefined();
    expect(upstreamHeaders.forwarded).toBeUndefined();
  });

  it('sends no authorization at all when the caller had none', async () => {
    const upstreamHeaders = await post({});

    // Dev-auth mode: the provider resolves `null` and the BFF must not invent a credential. A
    // proxy that supplied one of its own would make every visitor of an unauthenticated UI look
    // like the same authenticated principal to the backend.
    expect(upstreamHeaders.authorization).toBeUndefined();
  });
});
