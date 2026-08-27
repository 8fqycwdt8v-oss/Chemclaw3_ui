// @vitest-environment node
//
// Node, not happy-dom: these are properties of responses this process writes, and the probe is a
// real request across a real hop.

/**
 * The security headers are a property of the *process*, not of the static file handler.
 *
 * They used to be set inside `sirv`'s `setHeaders`, which meant `/api/*`, `/config.js` and
 * `/healthz` — every one of which returns before `sirv` is reached — carried no CSP and no
 * nosniff at all. Measured by proxying an HTML `<script>` body through a whitelisted route: it
 * came back on the app's own origin, `content-type: text/html`, with no policy of any kind. That
 * origin holds the bearer token, and the SPA's `script-src 'self'` is what makes the RDKit SVG
 * path unexploitable — a protection that stopped dead at the `/api` boundary.
 *
 * And framing: `AUTH_MODE=dev` dropped `frame-ancestors` to `*` **and** omitted
 * `X-Frame-Options`, for the sake of one deployment's preview iframe — in the mode that requires
 * no sign-in and opens every authorization gate, which is the one that can least afford to be
 * clickjacked.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

let upstream: http.Server;
let bff: http.Server;
let port = 0;

beforeAll(async () => {
  // An upstream that answers with HTML and its own headers, which is the case that matters: the
  // BFF must not let another service decide the policy of this origin.
  upstream = http.createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html',
      'content-security-policy': 'default-src *',
      'x-content-type-options': 'off',
    });
    res.end('<script>alert(document.domain)</script>');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  vi.resetModules();
  process.env.CHEMCLAW_API_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  process.env.CLIENT_DIR = '/nonexistent-client-dir';
  // The mode the repository's own launchers default to, and the one the framing relaxation used
  // to be attached to.
  process.env.AUTH_MODE = 'dev';
  delete process.env.ALLOW_FRAMING;
  const { createBffServer } = await import('../server/app.ts');

  bff = createBffServer();
  await new Promise<void>((resolve) => bff.listen(0, '127.0.0.1', resolve));
  port = (bff.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => bff.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

const get = async (path: string): Promise<Headers> =>
  (await fetch(`http://127.0.0.1:${port}${path}`)).headers;

describe('every surface this process serves', () => {
  // `/api/notes/x` is a whitelisted proxy route; the other two are answered locally, before the
  // static handler that used to be the only thing setting these.
  for (const path of ['/api/notes/x', '/config.js', '/healthz', '/']) {
    it(`states a policy on ${path}`, async () => {
      const headers = await get(path);

      expect(headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(headers.get('x-content-type-options')).toBe('nosniff');
      expect(headers.get('referrer-policy')).toBe('same-origin');
    });
  }

  it('does not let the upstream relax the policy of this origin', async () => {
    const headers = await get('/api/notes/x');

    expect(headers.get('content-security-policy')).not.toBe('default-src *');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('framing', () => {
  it('is refused in dev mode too, because dev mode is the one with no sign-in', async () => {
    const headers = await get('/');

    // Before: `frame-ancestors *` and no `X-Frame-Options` at all, on the deployment where
    // `useIsReviewer()` returns true for everybody and the backend's `_is_reviewer` opens too.
    expect(headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(headers.get('x-frame-options')).toBe('DENY');
  });
});
