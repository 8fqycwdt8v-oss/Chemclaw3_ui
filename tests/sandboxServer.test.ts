// @vitest-environment node
//
// Node, not happy-dom: the claims here are about response headers on real sockets.

/**
 * The HTML sandbox's listener (wave 3), and the app listener's refusal to be one.
 *
 * The frozen contract fixes the shell's headers to the token, so they are asserted to the token:
 * a CSP that quietly gained `connect-src 'self'`, or lost `frame-ancestors`, would still serve a
 * page that works — that is exactly the regression nobody sees. The other half is the app
 * listener: its asset handler falls back to `index.html` for any extensionless path, so without an
 * explicit refusal `/sandbox/frame` on the app origin would answer 200 with the SPA — a page, on the
 * origin holding the token, at the address the sandbox is supposed to own.
 *
 * Then the configuration: what turns the listener on, what is refused rather than served
 * half-working, and the one line the app's own CSP gains.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { renderSandboxShell, sandboxCsp } from '../server/sandbox.ts';
import { validateConfig, type BffConfig } from '../server/config.ts';

const APP = 'http://127.0.0.1:4321';

const EXPECTED_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; " +
  `base-uri 'none'; frame-ancestors ${APP}`;

/** Start a server on an ephemeral loopback port; hand back its base URL and a stop function. */
async function serve(server: http.Server): Promise<{ base: string; stop: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('the sandbox listener', () => {
  let base = '';
  let stop: () => Promise<void> = async () => {};

  beforeAll(async () => {
    vi.resetModules();
    const { createSandboxServer } = await import('../server/app.ts');
    ({ base, stop } = await serve(createSandboxServer(APP)));
  });
  afterAll(() => stop());

  it('serves the shell with exactly the contract’s headers, and no cookie', async () => {
    const res = await fetch(`${base}/sandbox/frame`, {
      headers: { authorization: 'Bearer should-be-ignored', cookie: 'a=b' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(EXPECTED_CSP);
    expect(sandboxCsp(APP)).toBe(EXPECTED_CSP);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-site');
    expect(res.headers.get('x-dns-prefetch-control')).toBe('off');
    expect(res.headers.get('set-cookie')).toBeNull();
    // Framable by the app — so the app's own `X-Frame-Options: DENY` must not be on this page.
    expect(res.headers.get('x-frame-options')).toBeNull();
    const body = await res.text();
    expect(body).toContain(`var APP = ${JSON.stringify(APP)};`);
    expect(body).toContain('event.origin !== APP');
    expect(body).toContain('event.source !== up');
  });

  it('answers HEAD, refuses other methods, and serves nothing else at all', async () => {
    const head = await fetch(`${base}/sandbox/frame`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-security-policy')).toBe(EXPECTED_CSP);
    const post = await fetch(`${base}/sandbox/frame`, { method: 'POST', body: 'x' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
    for (const other of ['/', '/index.html', '/config.js', '/api/healthz', '/healthz', '/x']) {
      const res = await fetch(`${base}${other}`);
      expect(res.status, other).toBe(404);
      expect(res.headers.get('content-security-policy'), other).toContain("default-src 'none'");
    }
  });

  it('writes the app origin into its script as a literal that cannot close the tag', () => {
    const shell = renderSandboxShell('http://x</script><script>alert(1)//');
    expect(shell.match(/<\/script>/g)).toHaveLength(1);
    expect(shell).toContain('\\u003c/script>');
  });
});

describe('the app listener', () => {
  let base = '';
  let stop: () => Promise<void> = async () => {};
  let clientDir = '';

  beforeAll(async () => {
    // A client build exists, so the SPA fallback *would* answer an extensionless path.
    clientDir = mkdtempSync(path.join(tmpdir(), 'chemclaw-sandbox-'));
    writeFileSync(path.join(clientDir, 'index.html'), '<!doctype html><title>the app</title>');
    vi.resetModules();
    process.env.CLIENT_DIR = clientDir;
    process.env.CHEMCLAW_API_URL = 'http://127.0.0.1:1';
    const { createBffServer } = await import('../server/app.ts');
    ({ base, stop } = await serve(createBffServer()));
  });
  afterAll(async () => {
    await stop();
    rmSync(clientDir, { recursive: true, force: true });
    delete process.env.CLIENT_DIR;
  });

  it('answers /sandbox/frame with a 404, never the app shell', async () => {
    const control = await fetch(`${base}/some/deep/link`);
    expect(await control.text()).toContain('the app');
    const res = await fetch(`${base}/sandbox/frame`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('the app');
  });
});

/* ── configuration ──────────────────────────────────────────────────────── */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function configFrom(env: Record<string, string>): Promise<BffConfig> {
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  return (await import('../server/config.ts')).cfg;
}

const frameSrc = (csp: string): string =>
  csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith('frame-src')) ?? '';

describe('turning the sandbox on', () => {
  it('runs only with both origins set and different, and opens frame-src to it alone', async () => {
    const on = await configFrom({
      BIND_HOST: '127.0.0.1',
      SANDBOX_ORIGIN: 'http://localhost:8081/',
      APP_ORIGIN: 'http://localhost:8080',
    });
    expect(on.sandboxEnabled).toBe(true);
    expect(on.sandboxOrigin).toBe('http://localhost:8081');
    expect(validateConfig(on)).toEqual([]);
    expect(frameSrc(on.csp)).toBe('frame-src http://localhost:8081');

    const off = await configFrom({});
    expect(off.sandboxEnabled).toBe(false);
    expect(frameSrc(off.csp)).toBe("frame-src 'none'");
  });

  it('keeps MSAL’s authority in frame-src beside the sandbox', async () => {
    const msal = await configFrom({
      AUTH_MODE: 'msal',
      ENTRA_TENANT_ID: 't',
      ENTRA_CLIENT_ID: 'c',
      API_SCOPE: 'api://c/x',
      SANDBOX_ORIGIN: 'https://sandbox.example',
      APP_ORIGIN: 'https://app.example',
    });
    expect(frameSrc(msal.csp)).toBe(
      'frame-src https://login.microsoftonline.com https://sandbox.example',
    );
  });

  it.each([
    [{ SANDBOX_ORIGIN: 'http://localhost:8081' }, /APP_ORIGIN is required/],
    [
      { SANDBOX_ORIGIN: 'http://localhost:8080', APP_ORIGIN: 'http://localhost:8080' },
      /must differ from APP_ORIGIN/,
    ],
    [{ SANDBOX_ORIGIN: 'http://localhost:8081/frame', APP_ORIGIN: 'http://a' }, /plain http/],
    [{ SANDBOX_ORIGIN: 'http://*', APP_ORIGIN: 'http://a' }, /plain http/],
    [{ SANDBOX_ORIGIN: 'http://s', APP_ORIGIN: 'javascript:alert(1)' }, /APP_ORIGIN must be/],
    [{ SANDBOX_ORIGIN: 'http://s.example', APP_ORIGIN: 'https://a.example' }, /mixed content/],
    [
      {
        SANDBOX_ORIGIN: 'http://localhost:8081',
        APP_ORIGIN: 'http://localhost:8080',
        PORT: '8081',
        SANDBOX_PORT: '8081',
      },
      /a port of its own/,
    ],
  ])('refuses %j rather than serving a sandbox that is not one', async (env, problem) => {
    const c = await configFrom({ BIND_HOST: '127.0.0.1', ...env });
    expect(validateConfig(c).join('\n')).toMatch(problem);
  });
});
