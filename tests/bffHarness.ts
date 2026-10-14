/**
 * A whole sign-in, in one process: the BFF's real request listener, the fixture identity provider
 * (`e2e/fixture-oidc.ts`), a stand-in Chemclaw service that validates the bearer it is sent, and a
 * browser that keeps cookies and follows redirects by hand.
 *
 * The BFF reads its configuration from the environment once, at import, so a stack stubs the
 * environment, resets the module registry and imports it fresh: each stack is its own BFF. That is
 * the only honest way to test the thing that matters here — what leaves this process, to whom, with
 * which cookie flags — because none of it is visible from a function's return value.
 */

import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import { startFixtureOidc } from '../e2e/fixture-oidc.ts';
import type { FixtureOidc, FixtureOidcOptions } from '../e2e/fixture-oidc.ts';

export const CLIENT_ID = 'chemclaw-bff-test';
export const CLIENT_SECRET = 'test-client-secret';
export const SID = 'a'.repeat(32);

export async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

export interface Seen {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** The Chemclaw service as the BFF sees it: bearer-checked, recording, and able to misbehave. */
export interface Core {
  url: string;
  seen: Seen[];
  /** Answer the next N authorised requests with 401 (a token revoked behind the BFF's back). */
  rejectNext: number;
  /** Bearers the service refuses whenever they arrive (revoked behind the BFF's back). */
  refused: Set<string>;
  /** Hold every answer this long (ms). */
  delayMs: number;
  close: () => Promise<void>;
}

async function startCore(idp: () => FixtureOidc): Promise<Core> {
  const core: Core = {
    url: '',
    seen: [],
    rejectNext: 0,
    refused: new Set<string>(),
    delayMs: 0,
    close: () => Promise.resolve(),
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      core.seen.push({
        method: req.method ?? 'GET',
        path,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      const answer = (): void => {
        if (path === '/healthz' || path === '/readyz') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
          return;
        }
        const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
        // Like core's front door: a token its provider issued, or nothing.
        if (
          !bearer ||
          !idp().accessTokens.includes(bearer) ||
          core.refused.has(bearer) ||
          core.rejectNext > 0
        ) {
          if (core.rejectNext > 0 && bearer) core.rejectNext -= 1;
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end('{"detail":"invalid token"}');
          return;
        }
        if (path.endsWith('/stream') || path.endsWith('/messages')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          let n = 0;
          const timer = setInterval(() => {
            n += 1;
            res.write(`event: token\ndata: {"type":"token","text":"t${n}"}\n\n`);
            if (n === 3) {
              clearInterval(timer);
              res.end();
            }
          }, 60);
          res.on('close', () => clearInterval(timer));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(path === '/sessions' && req.method === 'POST' ? { session_id: SID } : []),
        );
      };
      if (core.delayMs > 0) setTimeout(answer, core.delayMs);
      else answer();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  core.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  core.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return core;
}

/** A cookie as the jar holds it, with the attributes a test asserts on. */
export interface StoredCookie {
  value: string;
  raw: string;
}

/**
 * A browser, reduced to what the sign-in depends on: a jar per host, manual redirects, and a record
 * of every response (headers and body) it was ever shown — the thing "no token reaches the browser"
 * is asserted over.
 */
export class Browser {
  readonly jar = new Map<string, Map<string, StoredCookie>>();
  readonly shown: { url: string; headers: string; body: string }[] = [];
  /** Hosts the page names that really live at another address (`app.example` -> the BFF). */
  readonly hosts = new Map<string, string>();

  private real(url: string): string {
    const parsed = new URL(url);
    const host = this.hosts.get(parsed.host);
    if (!host) return url;
    parsed.protocol = 'http:';
    parsed.host = host;
    return parsed.toString();
  }

  cookies(url: string): Map<string, StoredCookie> {
    return this.jar.get(new URL(url).host) ?? new Map();
  }

  cookie(url: string, name: string): StoredCookie | undefined {
    return this.cookies(url).get(name);
  }

  /** One request, no redirect followed, cookies applied and stored. */
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const host = new URL(url).host;
    const jar = this.jar.get(host) ?? new Map<string, StoredCookie>();
    const headers = new Headers(init.headers);
    if (jar.size > 0 && !headers.has('cookie')) {
      headers.set('cookie', [...jar].map(([name, c]) => `${name}=${c.value}`).join('; '));
    }
    const res = await fetch(this.real(url), { ...init, headers, redirect: 'manual' });
    for (const raw of res.headers.getSetCookie()) {
      const [pair = '', ...attributes] = raw.split(';').map((part) => part.trim());
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const gone = attributes.some((a) => /^max-age=0$/i.test(a)) || value === '';
      const stored = this.jar.get(host) ?? new Map<string, StoredCookie>();
      if (gone) stored.delete(name);
      else stored.set(name, { value, raw });
      this.jar.set(host, stored);
    }
    const body = res.status >= 300 && res.status < 400 ? '' : await res.clone().text();
    this.shown.push({
      url,
      headers: [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n'),
      body,
    });
    return res;
  }

  /** Follow redirects like a navigation does; returns the final response and the URLs visited. */
  async navigate(url: string, init: RequestInit = {}): Promise<{ res: Response; chain: string[] }> {
    const chain = [url];
    let res = await this.request(url, init);
    for (let hops = 0; hops < 12 && res.status >= 300 && res.status < 400; hops += 1) {
      const next = new URL(res.headers.get('location') ?? '', chain[chain.length - 1]).toString();
      chain.push(next);
      res = await this.request(next);
    }
    return { res, chain };
  }
}

export interface Stack {
  /** The origin the browser reaches the BFF at (`APP_ORIGIN`). */
  origin: string;
  /** Where requests are really sent. */
  bffUrl: string;
  idp: FixtureOidc;
  core: Core;
  browser: Browser;
  /** Sign `person` in from `returnTo`; returns the final response of the whole navigation. */
  signIn: (
    person?: string,
    returnTo?: string,
    browser?: Browser,
  ) => Promise<{ res: Response; chain: string[] }>;
  stop: () => Promise<void>;
}

export interface StackOptions {
  /** Environment for the BFF on top of the defaults. */
  env?: Record<string, string>;
  idp?: Partial<FixtureOidcOptions>;
  /** `https://app.example`: the browser names that origin, the harness routes it to the BFF. */
  appOrigin?: string;
}

export async function startStack(options: StackOptions = {}): Promise<Stack> {
  const port = await freePort();
  const bffUrl = `http://127.0.0.1:${port}`;
  const origin = options.appOrigin ?? bffUrl;

  const idp = await startFixtureOidc({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUris: [`${origin}/auth/callback`],
    postLogoutRedirectUris: [`${origin}/`],
    ...options.idp,
  });
  const core = await startCore(() => idp);

  // A client directory with a shell in it, so a navigation lands on something.
  const clientDir = mkdtempSync(join(tmpdir(), 'bff-client-'));
  writeFileSync(join(clientDir, 'index.html'), '<!doctype html><title>Chemclaw</title>');

  const env: Record<string, string> = {
    CLIENT_DIR: clientDir,
    AUTH_MODE: 'bff',
    ENTRA_TENANT_ID: 'fixture-tenant',
    ENTRA_AUTHORITY: idp.authority,
    ENTRA_CLIENT_ID: CLIENT_ID,
    ENTRA_CLIENT_SECRET: CLIENT_SECRET,
    API_SCOPE: 'api://chemclaw/Chat.Access',
    APP_ORIGIN: origin,
    CHEMCLAW_API_URL: core.url,
    BIND_HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    SSE_HEARTBEAT_MS: '0',
    ...options.env,
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  const { createRequestListener } = await import('../server/app.ts');
  const server = http.createServer(createRequestListener());
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  const browser = new Browser();
  if (options.appOrigin) browser.hosts.set(new URL(options.appOrigin).host, `127.0.0.1:${port}`);

  const signIn: Stack['signIn'] = async (person = 'alice', returnTo = '/', who = browser) => {
    const login = await who.request(
      `${origin}/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
    );
    const authorize = new URL(login.headers.get('location') ?? '');
    authorize.searchParams.set('person', person);
    const chain = [`${origin}/auth/login`, authorize.toString()];
    let res = await who.request(authorize.toString());
    for (let hops = 0; hops < 8 && res.status >= 300 && res.status < 400; hops += 1) {
      const next = new URL(res.headers.get('location') ?? '', chain[chain.length - 1]).toString();
      chain.push(next);
      res = await who.request(next);
    }
    return { res, chain };
  };

  return {
    origin,
    bffUrl,
    idp,
    core,
    browser,
    signIn,
    async stop() {
      vi.unstubAllEnvs();
      vi.resetModules();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await core.close();
      await idp.close();
    },
  };
}
