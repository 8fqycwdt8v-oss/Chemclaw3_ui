/**
 * The whole BFF sign-in flow, end to end, against a mock identity provider.
 *
 * A real tenant round trip cannot be exercised here — there is no tenant — so this stands a mock
 * Entra on loopback and drives the actual `server/index.ts` process against it. That covers the
 * things a unit test over `seal`/`unseal` cannot: that the login cookie survives the redirect, that
 * the callback's state and nonce checks fire, that the session cookie is written and then presented
 * as a bearer token upstream, and that the browser's own `Authorization` never reaches the backend.
 *
 * What remains untested by anything in this repo, and is worth saying plainly: whether a real Entra
 * tenant accepts this client's authorize and token requests. The shapes are per the Microsoft
 * identity platform v2.0 documentation, but the first genuine confirmation will be a real sign-in.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SESSION_SECRET = 'a-test-session-secret-of-adequate-length-0123456789';
const UPSTREAM_TOKEN = 'upstream-access-token-issued-by-the-mock-idp';
const REFRESHED_TOKEN = 'a-second-access-token-from-the-refresh-grant';

/** What the mock backend saw, so the test can assert on headers rather than on responses. */
interface Seen {
  path: string;
  authorization: string | undefined;
}

let idp: http.Server;
let backend: http.Server;
let bff: ChildProcess;
let bffPort = 0;
let seen: Seen[] = [];
/** Set by the mock IdP's /authorize so the test can play the browser's part in the redirect. */
let lastAuthorize: URLSearchParams | null = null;
/** Flipped to make the mock IdP return a nonce that does not match the login. */
let nonceOverride: string | null = null;
let issuedRefreshTokens: string[] = [];

const listen = async (handler: http.RequestListener): Promise<http.Server> => {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
};

const portOf = (server: http.Server): number => (server.address() as AddressInfo).port;

/**
 * A free port, chosen by binding and immediately releasing one.
 *
 * `PORT=0` would be the obvious way to do this, but `validateConfig` refuses it — correctly, since
 * a real deployment on port 0 is a mistake — and loosening a boot guard to suit a test is the wrong
 * direction. The race between releasing and rebinding is theoretical on a loopback test host.
 */
async function freePort(): Promise<number> {
  const probe = await listen(() => {});
  const port = portOf(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** An unsigned id_token. The BFF reads it without verifying — see `readIdToken`'s docstring. */
function idToken(nonce: string): string {
  const claims = {
    oid: 'oid-of-the-test-user',
    preferred_username: 'chemist@example.com',
    name: 'A Chemist',
    roles: ['Chem.Reader'],
    nonce,
  };
  return [
    Buffer.from('{"alg":"none"}').toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'not-a-signature',
  ].join('.');
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    req.on('data', (c: Buffer) => (text += c.toString()));
    req.on('end', () => resolve(text));
  });
}

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A request to the BFF, with an explicit cookie jar so the test controls exactly what is sent. */
function call(
  path: string,
  options: {
    method?: string;
    cookies?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: bffPort,
        path,
        method: options.method ?? 'GET',
        headers: {
          host: `127.0.0.1:${bffPort}`,
          ...(options.cookies ? { cookie: options.cookies } : {}),
          ...options.headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
        );
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** Turn the `Set-Cookie` lines from a response into a `Cookie` header for the next one. */
function jar(...responses: Response[]): string {
  const store = new Map<string, string>();
  for (const res of responses) {
    for (const line of res.headers['set-cookie'] ?? []) {
      const pair = line.split(';')[0]!;
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      // A browser drops a cookie set with Max-Age=0; modelling that is what makes the
      // "logout actually clears the session" assertion meaningful.
      if (value === '' || /Max-Age=0/.test(line)) store.delete(name);
      else store.set(name, value);
    }
  }
  return [...store].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Read the authorize parameters out of a login redirect, and remember them.
 *
 * The mock IdP needs the `code_challenge` to verify PKCE at its token endpoint, and it never sees
 * `/authorize` itself because the test plays the browser. Every path that goes on to hit
 * `/auth/callback` must record them, or the exchange fails on a stale challenge from an earlier
 * test and the callback's own checks are never reached.
 */
function authorizeParams(login: Response): URLSearchParams {
  const params = new URL(login.headers.location!).searchParams;
  lastAuthorize = params;
  return params;
}

/** Complete a sign-in and return the cookie header a signed-in browser would hold. */
async function signIn(): Promise<string> {
  const login = await call('/auth/login');
  expect(login.status).toBe(302);
  const state = authorizeParams(login).get('state')!;
  const callback = await call(`/auth/callback?code=the-code&state=${encodeURIComponent(state)}`, {
    cookies: jar(login),
  });
  expect(callback.status).toBe(302);
  return jar(login, callback);
}

beforeAll(async () => {
  idp = await listen((req, res) => {
    const url = new URL(req.url ?? '/', 'http://idp.test');
    if (url.pathname.endsWith('/authorize')) {
      // The real Entra renders a login page here. The test plays the user by reading the
      // parameters and driving /auth/callback itself.
      res.writeHead(200).end('login page');
      return;
    }
    if (url.pathname.endsWith('/token')) {
      void readBody(req).then((body) => {
        const form = new URLSearchParams(body);
        // PKCE, actually verified: S256(code_verifier) must equal the challenge sent to /authorize.
        if (form.get('grant_type') === 'authorization_code') {
          const verifier = form.get('code_verifier') ?? '';
          const expected = lastAuthorize?.get('code_challenge');
          if (createHash('sha256').update(verifier).digest('base64url') !== expected) {
            res
              .writeHead(400, { 'content-type': 'application/json' })
              .end('{"error":"invalid_grant","error_description":"PKCE mismatch"}');
            return;
          }
        }
        const isRefresh = form.get('grant_type') === 'refresh_token';
        if (isRefresh) issuedRefreshTokens.push(form.get('refresh_token') ?? '');
        const nonce = nonceOverride ?? lastAuthorize?.get('nonce') ?? '';
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            access_token: isRefresh ? REFRESHED_TOKEN : UPSTREAM_TOKEN,
            refresh_token: isRefresh ? 'refresh-2' : 'refresh-1',
            // Deliberately short on the first issue: the proactive-refresh window is 11 minutes,
            // so a 60-second token is already inside it and the very next proxied request must
            // refresh rather than present a token that is about to expire.
            expires_in: 60,
            id_token: idToken(nonce),
          }),
        );
      });
      return;
    }
    res.writeHead(404).end();
  });

  backend = await listen((req, res) => {
    seen.push({ path: req.url ?? '', authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
  });

  bffPort = await freePort();
  bff = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', 'server/index.ts'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: String(bffPort),
        BIND_HOST: '127.0.0.1',
        AUTH_MODE: 'bff',
        CHEMCLAW_API_URL: `http://127.0.0.1:${portOf(backend)}`,
        ENTRA_AUTHORITY_HOST: `http://127.0.0.1:${portOf(idp)}`,
        ENTRA_TENANT_ID: 'tenant',
        ENTRA_CLIENT_ID: 'client',
        ENTRA_CLIENT_SECRET: 'secret',
        API_SCOPE: 'api://api-client/Chat.Access',
        SESSION_SECRET,
        SSE_HEARTBEAT_MS: '0',
        // `info`, not `error`: the readiness signal below IS a log line, and quietening the
        // process to errors only means waiting forever for something that is never printed.
        LOG_LEVEL: 'info',
        PUBLIC_ORIGIN: `http://127.0.0.1:${bffPort}`,
        CLIENT_DIR: 'dist/client',
      },
    },
  );

  // Wait for the process to say it is listening, rather than polling the port: a connection
  // refused during startup is indistinguishable from one refused because the process died.
  let buffered = '';
  await new Promise<void>((resolve, reject) => {
    // Comfortably inside the hook's own budget below, and deliberately so: this rejection carries
    // the process's buffered output, which is the only thing that says WHY it did not start. If
    // the hook timed out first that diagnostic would be lost. Generous because a loaded machine
    // has been observed taking several times the usual few hundred milliseconds here.
    const timer = setTimeout(
      () => reject(new Error(`BFF did not start within 25s. Output:\n${buffered}`)),
      25_000,
    );
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString();
      if (buffered.includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    };
    bff.stdout?.on('data', onData);
    bff.stderr?.on('data', onData);
    bff.on('exit', (code) => reject(new Error(`BFF exited with ${code}: ${buffered}`)));
  });
}, 45_000);

afterAll(async () => {
  bff.kill('SIGKILL');
  await new Promise<void>((resolve) => idp.close(() => resolve()));
  await new Promise<void>((resolve) => backend.close(() => resolve()));
});

describe('the login leg', () => {
  it('redirects to the provider with PKCE, state and nonce', async () => {
    const res = await call('/auth/login?returnTo=%2Fchat');
    expect(res.status).toBe(302);
    const url = new URL(res.headers.location!);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toHaveLength(43);
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    // Without offline_access there is no refresh token, so every session would die within the hour.
    expect(url.searchParams.get('scope')).toContain('offline_access');
    expect(url.searchParams.get('scope')).toContain('api://api-client/Chat.Access');
    // `form_post` would return the code as a cross-site POST, on which a Lax cookie is withheld.
    expect(url.searchParams.get('response_mode')).toBe('query');
  });

  it('puts the verifier in an httpOnly cookie and never in the URL', async () => {
    const res = await call('/auth/login');
    const cookie = (res.headers['set-cookie'] ?? []).find((c) => c.startsWith('ccl='))!;
    expect(cookie).toContain('HttpOnly');
    expect(res.headers.location).not.toContain('code_verifier');
  });

  it('refuses to bounce the browser off-origin after sign-in', async () => {
    // An open redirect attached to a login flow is the useful kind: the victim really did just
    // authenticate, so whatever they land on inherits that trust.
    for (const evil of ['//evil.test/', 'https://evil.test/', '/\\evil.test']) {
      const login = await call(`/auth/login?returnTo=${encodeURIComponent(evil)}`);
      const state = authorizeParams(login).get('state')!;
      const callback = await call(`/auth/callback?code=c&state=${encodeURIComponent(state)}`, {
        cookies: jar(login),
      });
      expect(callback.headers.location).toBe('/');
    }
  });
});

describe('the callback leg', () => {
  it('completes a sign-in and writes a session', async () => {
    const cookies = await signIn();
    expect(cookies).toMatch(/ccs0=/);
    expect(cookies).toMatch(/ccx=/);
    // The login cookie must be gone: it has served its purpose and holds a PKCE verifier.
    expect(cookies).not.toMatch(/ccl=/);

    const me = await call('/auth/me', { cookies });
    const body = JSON.parse(me.body) as Record<string, unknown>;
    expect(body.authenticated).toBe(true);
    expect(body.username).toBe('chemist@example.com');
    // The entire point of this mode: no token in anything the browser can read.
    expect(me.body).not.toContain(UPSTREAM_TOKEN);
    expect(cookies).not.toContain(UPSTREAM_TOKEN);
  });

  it('refuses a callback whose state does not match the login', async () => {
    const login = await call('/auth/login');
    const res = await call('/auth/callback?code=c&state=not-the-state', { cookies: jar(login) });
    expect(res.status).toBe(400);
    expect(res.headers['set-cookie']?.join()).not.toMatch(/ccs0=[^;]/);
  });

  it('refuses a callback with no login cookie at all', async () => {
    const res = await call('/auth/callback?code=c&state=anything');
    expect(res.status).toBe(400);
  });

  it('refuses an id_token minted for a different login', async () => {
    // Same tenant, same client, genuinely issued — but for someone else's authorize request.
    nonceOverride = 'a-nonce-from-another-login';
    try {
      const login = await call('/auth/login');
      const state = authorizeParams(login).get('state')!;
      const res = await call(`/auth/callback?code=c&state=${encodeURIComponent(state)}`, {
        cookies: jar(login),
      });
      expect(res.status).toBe(400);
    } finally {
      nonceOverride = null;
    }
  });

  it('reports a provider-side refusal without echoing its detail', async () => {
    const res = await call(
      '/auth/callback?error=access_denied&error_description=AADSTS65004%20detail',
    );
    expect(res.status).toBe(400);
    expect(res.body).not.toContain('AADSTS');
    expect(res.body).toContain('/auth/login');
  });
});

describe('token injection', () => {
  it('presents the session token upstream, and never the browser’s own', async () => {
    const cookies = await signIn();
    seen = [];
    const res = await call('/api/healthz', {
      cookies,
      headers: { authorization: 'Bearer forged' },
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    // A forged bearer must not reach the backend: under BFF custody the only token that counts is
    // the one this process holds, and forwarding the browser's would make the cookie bypassable.
    expect(seen[0]!.authorization).not.toContain('forged');
    // 60-second expiry is inside the refresh window, so the proxied request refreshed first.
    expect(seen[0]!.authorization).toBe(`Bearer ${REFRESHED_TOKEN}`);
  });

  it('strips a bearer token from an anonymous caller too', async () => {
    seen = [];
    const res = await call('/api/healthz', { headers: { authorization: 'Bearer forged' } });
    expect(res.status).toBe(200);
    expect(seen[0]!.authorization).toBeUndefined();
  });

  it('collapses concurrent refreshes onto one grant', async () => {
    // Entra rotates refresh tokens, so two concurrent refreshes would present the same spent
    // token twice and the second would come back invalid_grant — signing the user out mid-work.
    const cookies = await signIn();
    issuedRefreshTokens = [];
    await Promise.all([
      call('/api/healthz', { cookies }),
      call('/api/healthz', { cookies }),
      call('/api/healthz', { cookies }),
    ]);
    expect(new Set(issuedRefreshTokens).size).toBeLessThanOrEqual(issuedRefreshTokens.length);
    expect(issuedRefreshTokens.length).toBeLessThan(3);
  });
});

describe('CSRF', () => {
  it('refuses a state-changing request from another origin', async () => {
    const cookies = await signIn();
    seen = [];
    const res = await call('/api/sessions', {
      method: 'POST',
      cookies,
      headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    // Refused here, so the backend never sees it.
    expect(seen).toHaveLength(0);
  });

  it('refuses a same-origin POST with no CSRF header', async () => {
    const cookies = await signIn();
    const res = await call('/api/sessions', {
      method: 'POST',
      cookies,
      headers: { origin: `http://127.0.0.1:${bffPort}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('accepts a same-origin POST that echoes the token', async () => {
    const cookies = await signIn();
    const csrf = decodeURIComponent(/ccx=([^;]+)/.exec(cookies)![1]!);
    seen = [];
    const res = await call('/api/sessions', {
      method: 'POST',
      cookies,
      headers: {
        origin: `http://127.0.0.1:${bffPort}`,
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it('leaves GET alone, which is what keeps the transcript readable', async () => {
    const cookies = await signIn();
    const res = await call('/api/sessions', { cookies });
    expect(res.status).toBe(200);
  });

  it('does not fire for a request carrying no session', async () => {
    // Nothing to forge the use of. The backend's own 401 is the honest answer here, not a
    // CSRF failure reported to someone who is simply not signed in.
    const res = await call('/api/sessions', {
      method: 'POST',
      headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });
});

describe('logout', () => {
  it('clears the session and points at the tenant sign-out', async () => {
    const cookies = await signIn();
    const csrf = decodeURIComponent(/ccx=([^;]+)/.exec(cookies)![1]!);
    const res = await call('/auth/logout', {
      method: 'POST',
      cookies,
      headers: { origin: `http://127.0.0.1:${bffPort}`, 'x-csrf-token': csrf },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).signOutUrl).toContain('/logout');

    const after = jar({ headers: { 'set-cookie': [] } } as unknown as Response, res);
    const me = await call('/auth/me', { cookies: after });
    expect(JSON.parse(me.body).authenticated).toBe(false);
  });

  it('refuses a cross-origin logout, which would be a nuisance CSRF', async () => {
    const cookies = await signIn();
    const res = await call('/auth/logout', {
      method: 'POST',
      cookies,
      headers: { origin: 'https://evil.test' },
    });
    expect(res.status).toBe(403);
  });
});

describe('an unauthenticated caller', () => {
  it('gets a plain answer from /auth/me rather than an error', async () => {
    const res = await call('/auth/me');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ authenticated: false });
  });

  it('is not signed in by a forged session cookie', async () => {
    const res = await call('/auth/me', { cookies: 'ccs0=not.a.session' });
    expect(JSON.parse(res.body).authenticated).toBe(false);
  });
});
