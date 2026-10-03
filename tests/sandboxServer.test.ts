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
import { RTC_PRELUDE, renderSandboxShell, sandboxCsp } from '../server/sandbox.ts';
import { sandboxState, validateConfig, type BffConfig } from '../server/config.ts';

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
    // Scripts off unless the app's message says otherwise (wave-3 amendment): the artefact goes in
    // a nested frame whose sandbox is empty, and the WebRTC prelude rides only a scripted render.
    // What the browser does with that is e2e/sandbox.spec.ts's to prove.
    expect(body).toContain('var scripts = data.scripts === true;');
    expect(body).toContain("frame.setAttribute('sandbox', scripts ? 'allow-scripts' : '');");
    expect(body).toContain('frame.srcdoc = html;');
    expect(body).not.toContain('document.write');
    expect(RTC_PRELUDE).toMatch(/RTCPeerConnection.*webkitRTCPeerConnection.*RTCDataChannel/);
  });

  it('answers HEAD, refuses other methods, and serves nothing else at all', async () => {
    const head = await fetch(`${base}/sandbox/frame`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-security-policy')).toBe(EXPECTED_CSP);
    const post = await fetch(`${base}/sandbox/frame`, { method: 'POST', body: 'x' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
    // A refusal carries the closed policy too, so no response on this origin goes out without one.
    expect(post.headers.get('content-security-policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(post.headers.get('x-content-type-options')).toBe('nosniff');
    for (const other of ['/', '/index.html', '/config.js', '/api/healthz', '/healthz', '/x']) {
      const res = await fetch(`${base}${other}`);
      expect(res.status, other).toBe(404);
      expect(res.headers.get('content-security-policy'), other).toContain("default-src 'none'");
    }
  });

  it('says it is ready, to the app origin only, once its listener is armed', () => {
    const shell = renderSandboxShell(APP);
    const listening = shell.indexOf("addEventListener('message'");
    const ready = shell.indexOf("up.postMessage({ type: 'ready' }, APP)");
    expect(listening).toBeGreaterThan(0);
    expect(ready).toBeGreaterThan(listening);
    // Nothing else is posted but the height.
    expect(shell.match(/postMessage\(/g)).toHaveLength(2);
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

  it('never lets the app frame anything but the sandbox and the sign-in authority', async () => {
    // frame-src is what bounds the sandbox frame's own navigation (README, "HTML sandbox"): a page
    // that navigates its frame elsewhere is refused only because nothing else is listed. Widening
    // it — a wildcard, a scheme, `'self'`, a second host — re-opens that exit, so it fails here.
    const sandbox = {
      SANDBOX_ORIGIN: 'https://sandbox.example',
      APP_ORIGIN: 'https://app.example',
    };
    const msal = {
      AUTH_MODE: 'msal',
      ENTRA_TENANT_ID: 't',
      ENTRA_CLIENT_ID: 'c',
      API_SCOPE: 'api://c/x',
    };
    const cases: [Record<string, string>, string[]][] = [
      [{}, ["'none'"]],
      [sandbox, ['https://sandbox.example']],
      [msal, ['https://login.microsoftonline.com']],
      [{ ...msal, ...sandbox }, ['https://login.microsoftonline.com', 'https://sandbox.example']],
      [
        { ...msal, ...sandbox, ENTRA_AUTHORITY: 'https://login.example.us/t' },
        ['https://login.example.us', 'https://sandbox.example'],
      ],
    ];
    for (const [env, allowed] of cases) {
      const c = await configFrom(env);
      const sources = frameSrc(c.csp).split(/\s+/).slice(1);
      expect(sources, JSON.stringify(env)).toEqual(allowed);
      // And no directive that would also govern frames by fallback says more.
      expect(c.csp, JSON.stringify(env)).not.toMatch(/child-src|default-src [^;]*\*/);
    }
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
    ...['0', '65536', '-1', '80.5', 'abc', '8081x'].map(
      (port) =>
        [
          {
            SANDBOX_ORIGIN: 'http://localhost:8081',
            APP_ORIGIN: 'http://localhost:8080',
            SANDBOX_PORT: port,
          },
          /SANDBOX_PORT .* is not a port/,
        ] as [Record<string, string>, RegExp],
    ),
    [{ HTML_SCRIPTS_DEFAULT: 'yes' }, /HTML_SCRIPTS_DEFAULT "yes" is not "on" or "off"/],
  ])('refuses %j rather than serving a sandbox that is not one', async (env, problem) => {
    const c = await configFrom({ BIND_HOST: '127.0.0.1', ...env });
    expect(validateConfig(c).join('\n')).toMatch(problem);
  });

  it.each(['0', 'abc', '70000'])(
    'refuses SANDBOX_PORT=%s even with no sandbox configured',
    async (port) => {
      const c = await configFrom({ BIND_HOST: '127.0.0.1', SANDBOX_PORT: port });
      expect(c.sandboxEnabled).toBe(false);
      expect(validateConfig(c).join('\n')).toMatch(/SANDBOX_PORT .* is not a port/);
    },
  );

  it.each([
    ['https://intranet.example/chemclaw-ui/', true],
    ['/docs/', true],
    ['javascript:alert(1)//', false],
    ['//evil.example/', false],
    ['data:text/html,x', false],
  ])('DOCS_BASE_URL=%s is accepted: %s', async (base, ok) => {
    const c = await configFrom({ BIND_HOST: '127.0.0.1', DOCS_BASE_URL: base });
    expect(validateConfig(c).some((p) => p.startsWith('DOCS_BASE_URL'))).toBe(!ok);
  });

  it.each(['1', '8081', '65535'])('takes SANDBOX_PORT=%s', async (port) => {
    const c = await configFrom({
      BIND_HOST: '127.0.0.1',
      SANDBOX_ORIGIN: 'http://localhost:8081',
      APP_ORIGIN: 'http://localhost:8080',
      SANDBOX_PORT: port,
    });
    expect(validateConfig(c)).toEqual([]);
  });
});

describe('the sandbox beside ALLOW_FRAMING', () => {
  it('is turned off with its reason rather than refused, and frame-src stays closed', async () => {
    // Chosen over a refusal (README "HTML sandbox"): every shipped launcher sets the sandbox
    // origins, and the shell's `frame-ancestors` names APP_ORIGIN alone while CSP checks every
    // ancestor, so inside a preview host's frame the sandbox could only ever be a blank box.
    const c = await configFrom({
      BIND_HOST: '127.0.0.1',
      SANDBOX_ORIGIN: 'http://localhost:8081',
      APP_ORIGIN: 'http://localhost:8080',
      ALLOW_FRAMING: 'true',
    });
    expect(validateConfig(c)).toEqual([]);
    expect(c.sandboxEnabled).toBe(false);
    expect(c.sandboxReason).toMatch(/^ALLOW_FRAMING=true/);
    expect(frameSrc(c.csp)).toBe("frame-src 'none'");
    vi.resetModules();
    const { runtimeConfig } = await import('../server/runtimeConfig.ts');
    expect(runtimeConfig().sandboxOrigin).toBe('');
  });

  it('says why in every state', () => {
    const base = { rawSandboxOrigin: '', sandboxOrigin: '', appOrigin: '', allowFraming: false };
    expect(sandboxState(base)).toEqual({
      on: false,
      reason: expect.stringMatching(/SANDBOX_ORIGIN is unset/),
    });
    const set = {
      rawSandboxOrigin: 'http://s:2',
      sandboxOrigin: 'http://s:2',
      appOrigin: 'http://a:1',
      allowFraming: false,
    };
    expect(sandboxState(set)).toEqual({ on: true, reason: expect.stringContaining('http://s:2') });
    expect(sandboxState({ ...set, allowFraming: true }).on).toBe(false);
    expect(sandboxState({ ...set, appOrigin: 'http://s:2' }).on).toBe(false);
  });
});

describe('HTML_SCRIPTS_DEFAULT', () => {
  it.each([
    [{}, true],
    [{ HTML_SCRIPTS_DEFAULT: 'on' }, true],
    [{ HTML_SCRIPTS_DEFAULT: 'OFF' }, false],
    [{ HTML_SCRIPTS_DEFAULT: 'off' }, false],
  ])('%j runs scripts by default: %s', async (env, on) => {
    const c = await configFrom({ BIND_HOST: '127.0.0.1', ...env });
    expect(validateConfig(c)).toEqual([]);
    expect(c.htmlScriptsDefault).toBe(on);
  });
});
