// @vitest-environment node
//
// Node, not the suite's default happy-dom: this drives a *server* over real sockets, and happy-dom
// applies the browser's same-origin policy to `fetch`.

/**
 * The sign-in the BFF performs on the browser's behalf, from the first redirect to the cookie.
 *
 * Each case runs the whole chain — the BFF's real listener, a fixture identity provider that signs
 * real tokens, a browser that keeps cookies — because the properties here are about what crosses
 * the wire: which parameters leave for the provider, what is accepted coming back, which flags the
 * cookie carries, and what the browser is ever shown. A unit test of `verifyIdToken` would pass
 * with the callback wired to skip it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALICE } from '../e2e/fixture-oidc.ts';
import { Browser, CLIENT_ID, startStack } from './bffHarness.ts';
import type { Stack } from './bffHarness.ts';

let stack: Stack;
const cookieName = 'chemclaw_session';

beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack.stop();
});

/** A fresh browser, so a case never inherits the last one's cookies or recordings. */
const freshBrowser = (): Browser => new Browser();

describe('the authorization request', () => {
  it('sends PKCE (S256), a state, a nonce, the redirect URI, and the API scope with offline_access', async () => {
    const res = await freshBrowser().request(`${stack.origin}/auth/login?returnTo=%2Fjobs`);
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location') ?? '');

    expect(url.origin + url.pathname).toBe(`${stack.idp.authority}/oauth2/v2.0/authorize`);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(`${stack.origin}/auth/callback`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('scope')).toBe(
      'openid profile offline_access api://chemclaw/Chat.Access',
    );
    // The verifier itself is never sent: only its hash.
    expect(url.search).not.toMatch(/code_verifier/);
  });

  it('takes the redirect URI, client and scope from configuration, never from the request', async () => {
    const res = await freshBrowser().request(
      `${stack.origin}/auth/login?redirect_uri=https%3A%2F%2Fevil.example%2F&client_id=evil&scope=admin` +
        '&state=chosen&nonce=chosen&code_challenge=chosen&response_type=token',
    );
    const url = new URL(res.headers.get('location') ?? '');
    expect(url.searchParams.get('redirect_uri')).toBe(`${stack.origin}/auth/callback`);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).not.toContain('admin');
    for (const name of ['state', 'nonce', 'code_challenge']) {
      expect(url.searchParams.get(name)).not.toBe('chosen');
    }
  });

  it('uses fresh state, nonce and verifier for every sign-in', async () => {
    const a = new URL(
      (await freshBrowser().request(`${stack.origin}/auth/login`)).headers.get('location') ?? '',
    );
    const b = new URL(
      (await freshBrowser().request(`${stack.origin}/auth/login`)).headers.get('location') ?? '',
    );
    for (const name of ['state', 'nonce', 'code_challenge']) {
      expect(a.searchParams.get(name)).not.toBe(b.searchParams.get(name));
    }
  });

  it('binds the sign-in to the browser with a short-lived, HttpOnly, Lax cookie', async () => {
    const browser = freshBrowser();
    const res = await browser.request(`${stack.origin}/auth/login`);
    const raw = res.headers.getSetCookie().join('\n');
    expect(raw).toMatch(
      /^chemclaw_login=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600$/,
    );
    expect(raw).not.toMatch(/Domain/i);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('a completed sign-in', () => {
  it('ends on the page it started from, with a session cookie and no token anywhere', async () => {
    const browser = freshBrowser();
    const { res, chain } = await stack.signIn('alice', '/jobs?tab=open#top', browser);

    // The whole route: login -> provider -> callback -> where sign-in started, marker added.
    expect(chain[chain.length - 1]).toBe(`${stack.origin}/jobs?tab=open&signed_in=1#top`);
    expect(res.status).toBe(200); // the SPA shell (no client build here: a 404 page is also fine)
  });

  it('sets the session cookie HttpOnly, SameSite=Strict, host-only, with a bounded life', async () => {
    const browser = freshBrowser();
    await stack.signIn('alice', '/', browser);
    const cookie = browser.cookie(stack.origin, cookieName);
    expect(cookie, 'a session cookie').toBeDefined();
    expect(cookie?.raw).toMatch(
      /^chemclaw_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=86400$/,
    );
    // Over plain-http loopback: neither Secure nor __Host- (see the https case below).
    expect(cookie?.raw).not.toMatch(/Secure|Domain/);
    // The login binding is gone.
    expect(browser.cookie(stack.origin, 'chemclaw_login')).toBeUndefined();
  });

  it('reports who signed in, and nothing that is a token', async () => {
    const browser = freshBrowser();
    await stack.signIn('alice', '/', browser);
    const res = await browser.request(`${stack.origin}/auth/session`);
    expect(await res.json()).toEqual({
      authenticated: true,
      account: { id: ALICE.oid, username: ALICE.upn, name: ALICE.name, roles: ALICE.roles },
    });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('is not signed in without the cookie', async () => {
    const res = await freshBrowser().request(`${stack.origin}/auth/session`);
    expect(await res.json()).toEqual({ authenticated: false });
  });

  it('exchanges the code with the client secret and the PKCE verifier, once', async () => {
    const before = stack.idp.tokenRequests.length;
    await stack.signIn('alice', '/', freshBrowser());
    const exchange = stack.idp.tokenRequests
      .slice(before)
      .filter((r) => r.grant_type === 'authorization_code');
    expect(exchange).toHaveLength(1);
    expect(exchange[0]).toMatchObject({
      client_id: CLIENT_ID,
      client_secret: 'test-client-secret',
      redirect_uri: `${stack.origin}/auth/callback`,
    });
    expect(exchange[0]?.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('shows the browser no access, refresh or ID token in any response it received', async () => {
    const browser = freshBrowser();
    await stack.signIn('alice', '/', browser);
    await browser.request(`${stack.origin}/auth/session`);
    await browser.request(`${stack.origin}/config.js`);
    await browser.request(`${stack.origin}/api/sessions`, { headers: { 'x-chemclaw-csrf': '1' } });
    await browser.request(`${stack.origin}/api/sessions`, {
      method: 'POST',
      headers: { 'x-chemclaw-csrf': '1', 'content-type': 'application/json', origin: stack.origin },
      body: '{}',
    });

    const everything = browser.shown.map((r) => `${r.url}\n${r.headers}\n${r.body}`).join('\n');
    expect(everything).not.toMatch(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\./); // no JWT of any kind
    expect(everything).not.toMatch(/rt-[A-Za-z0-9_-]{20,}/); // no refresh token
    for (const token of stack.idp.accessTokens) expect(everything).not.toContain(token);
    expect(everything).not.toContain('test-client-secret');
    // And the cookie is the only thing the BFF set that outlives the sign-in.
    expect(browser.cookies(stack.origin).size).toBe(1);
  });

  it('serves /config.js without the tenant, client id, secret or scope', async () => {
    const body = await (await freshBrowser().request(`${stack.origin}/config.js`)).text();
    expect(body).toContain('"authMode":"bff"');
    for (const secret of [CLIENT_ID, 'test-client-secret', 'fixture-tenant', 'api://chemclaw']) {
      expect(body).not.toContain(secret);
    }
  });
});

describe('what is refused coming back from the provider', () => {
  /** Start a sign-in, then answer the callback with `mutate` applied to what the provider sent. */
  async function callbackWith(
    mutate: (callback: URL) => void,
    browser: Browser = freshBrowser(),
  ): Promise<Response> {
    const login = await browser.request(`${stack.origin}/auth/login`);
    const authorize = new URL(login.headers.get('location') ?? '');
    authorize.searchParams.set('person', 'alice');
    const back = await browser.request(authorize.toString());
    const callback = new URL(back.headers.get('location') ?? '');
    mutate(callback);
    return browser.request(callback.toString());
  }

  const noSession = async (browser: Browser): Promise<void> => {
    expect(browser.cookie(stack.origin, cookieName)).toBeUndefined();
    expect(await (await browser.request(`${stack.origin}/auth/session`)).json()).toEqual({
      authenticated: false,
    });
  };

  it('a state this process never issued', async () => {
    const browser = freshBrowser();
    const res = await callbackWith((cb) => cb.searchParams.set('state', 'x'.repeat(43)), browser);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Try again');
    await noSession(browser);
  });

  it('a missing state', async () => {
    const browser = freshBrowser();
    const res = await callbackWith((cb) => cb.searchParams.delete('state'), browser);
    expect(res.status).toBe(400);
    await noSession(browser);
  });

  it('a callback replayed after it succeeded', async () => {
    const browser = freshBrowser();
    const login = await browser.request(`${stack.origin}/auth/login`);
    const authorize = new URL(login.headers.get('location') ?? '');
    authorize.searchParams.set('person', 'alice');
    const callback = (await browser.request(authorize.toString())).headers.get('location') ?? '';
    expect((await browser.request(callback)).status).toBe(302);
    const replay = await browser.request(callback);
    expect(replay.status).toBe(400);
  });

  it('a state started in a different browser (login CSRF)', async () => {
    const attacker = freshBrowser();
    const login = await attacker.request(`${stack.origin}/auth/login`);
    const authorize = new URL(login.headers.get('location') ?? '');
    authorize.searchParams.set('person', 'alice');
    // The attacker signs in at the provider and hands the callback URL to a victim.
    const callback = (await attacker.request(authorize.toString())).headers.get('location') ?? '';

    const victim = freshBrowser();
    const res = await victim.request(callback);
    expect(res.status).toBe(400);
    await noSession(victim);
  });

  it('an ID token whose nonce is not this sign-in’s', async () => {
    stack.idp.behaviour.idToken = { nonce: 'someone-elses-nonce' };
    try {
      const browser = freshBrowser();
      const { res } = await stack.signIn('alice', '/', browser);
      expect(res.status).toBe(403);
      await noSession(browser);
    } finally {
      stack.idp.behaviour.idToken = {};
    }
  });

  it.each([
    ['has expired', { expired: true }],
    ['is signed by a key the provider does not publish', { badSignature: true }],
    ['names another issuer', { issuer: 'https://evil.example/v2.0' }],
    ['is for another client', { audience: 'some-other-client' }],
  ])('an ID token that %s', async (_why, tamper) => {
    stack.idp.behaviour.idToken = tamper;
    try {
      const browser = freshBrowser();
      const { res } = await stack.signIn('alice', '/', browser);
      expect(res.status).toBe(403);
      await noSession(browser);
    } finally {
      stack.idp.behaviour.idToken = {};
    }
  });

  it('a token response with no ID token', async () => {
    stack.idp.behaviour.idToken = { omit: true };
    try {
      const browser = freshBrowser();
      const { res } = await stack.signIn('alice', '/', browser);
      expect(res.status).toBe(403);
      await noSession(browser);
    } finally {
      stack.idp.behaviour.idToken = {};
    }
  });

  it('a code the provider refuses to exchange', async () => {
    stack.idp.behaviour.codeFails = true;
    try {
      const browser = freshBrowser();
      const { res } = await stack.signIn('alice', '/', browser);
      expect(res.status).toBe(403);
      await noSession(browser);
    } finally {
      stack.idp.behaviour.codeFails = false;
    }
  });

  it('an error from the provider (the person cancelled)', async () => {
    const browser = freshBrowser();
    const { res } = await stack.signIn('deny', '/', browser);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('access_denied');
    await noSession(browser);
  });

  it('says nothing of why in the page, and clears the login cookie', async () => {
    stack.idp.behaviour.idToken = { expired: true };
    try {
      const browser = freshBrowser();
      const { res } = await stack.signIn('alice', '/', browser);
      const page = await res.text();
      expect(page).not.toMatch(/expired|signature|nonce|JWT/i);
      expect(browser.cookie(stack.origin, 'chemclaw_login')).toBeUndefined();
    } finally {
      stack.idp.behaviour.idToken = {};
    }
  });
});

describe('where a sign-in may return to', () => {
  const landing = async (returnTo: string): Promise<string> => {
    const { chain } = await stack.signIn('alice', returnTo, freshBrowser());
    return (
      new URL(chain[chain.length - 1] ?? '').pathname +
      new URL(chain[chain.length - 1] ?? '').search
    );
  };

  it.each([
    ['https://evil.example/', '/'],
    ['//evil.example/phish', '/'],
    ['/\\evil.example', '/'],
    ['javascript:alert(1)', '/'],
    ['/auth/login', '/'],
    ['/api/sessions', '/'],
    ['/path\r\nSet-Cookie: x=1', '/'],
    ['', '/'],
  ])('refuses %j and lands on the root', async (returnTo, expected) => {
    expect((await landing(returnTo)).startsWith(expected)).toBe(true);
    expect(await landing(returnTo)).toBe('/?signed_in=1');
  });

  it('keeps a path on this origin, with its query', async () => {
    expect(await landing('/open/' + 'f'.repeat(32) + '?x=1')).toBe(
      `/open/${'f'.repeat(32)}?x=1&signed_in=1`,
    );
  });
});

describe('session fixation', () => {
  it('issues a new id at sign-in, and a pre-set one never becomes authenticated', async () => {
    const browser = freshBrowser();
    const planted = 'p'.repeat(43);
    browser.jar.set(
      new URL(stack.origin).host,
      new Map([[cookieName, { value: planted, raw: '' }]]),
    );

    await stack.signIn('alice', '/', browser);
    const issued = browser.cookie(stack.origin, cookieName)?.value;
    expect(issued).toBeDefined();
    expect(issued).not.toBe(planted);

    const attacker = freshBrowser();
    attacker.jar.set(
      new URL(stack.origin).host,
      new Map([[cookieName, { value: planted, raw: '' }]]),
    );
    expect(await (await attacker.request(`${stack.origin}/auth/session`)).json()).toEqual({
      authenticated: false,
    });
  });

  it('ends the session the browser held before, when it signs in again', async () => {
    const browser = freshBrowser();
    await stack.signIn('alice', '/', browser);
    const first = browser.cookie(stack.origin, cookieName)?.value ?? '';

    await stack.signIn('bob', '/', browser);
    const second = browser.cookie(stack.origin, cookieName)?.value ?? '';
    expect(second).not.toBe(first);

    const old = freshBrowser();
    old.jar.set(new URL(stack.origin).host, new Map([[cookieName, { value: first, raw: '' }]]));
    expect(await (await old.request(`${stack.origin}/auth/session`)).json()).toEqual({
      authenticated: false,
    });
  });
});

describe('the provider is not there', () => {
  it('answers 503 with a way back rather than redirecting nowhere', async () => {
    const down = await startStack({ idp: {}, env: { OIDC_HTTP_TIMEOUT_MS: '500' } });
    try {
      await down.idp.close();
      const res = await freshBrowser().request(`${down.origin}/auth/login`);
      expect(res.status).toBe(503);
      expect(await res.text()).toContain('Try again');
    } finally {
      await down.stop();
    }
  });
});

describe('over https', () => {
  it('names the cookies __Host- and marks them Secure', async () => {
    const secure = await startStack({ appOrigin: 'https://app.example' });
    try {
      const browser = freshBrowser();
      browser.hosts.set('app.example', new URL(secure.bffUrl).host);
      const login = await browser.request('https://app.example/auth/login');
      expect(login.headers.getSetCookie().join()).toMatch(
        /^__Host-chemclaw_login=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=600$/,
      );
      await secure.signIn('alice', '/', browser);
      const cookie = browser.cookie('https://app.example', '__Host-chemclaw_session');
      expect(cookie?.raw).toMatch(
        /^__Host-chemclaw_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=86400$/,
      );
      // `__Host-` forbids a Domain attribute; it must be absent.
      expect(cookie?.raw).not.toMatch(/Domain/i);
    } finally {
      await secure.stop();
    }
  });
});
