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

  it('keeps the sign-in in a sealed, short-lived, HttpOnly, Lax cookie named for its state', async () => {
    const browser = freshBrowser();
    const res = await browser.request(`${stack.origin}/auth/login`);
    const raw = res.headers.getSetCookie().join('\n');
    expect(raw).toMatch(
      /^chemclaw_login_[A-Za-z0-9_-]{22}=[A-Za-z0-9_-]{100,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600$/,
    );
    // Sealed: neither the verifier nor the nonce is readable in it.
    const url = new URL(res.headers.get('location') ?? '');
    const value = raw.split('=')[1]?.split(';')[0] ?? '';
    expect(Buffer.from(value, 'base64url').toString('latin1')).not.toContain(
      url.searchParams.get('nonce') ?? 'x',
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
    expect(browser.cookiesWithPrefix(stack.origin, 'chemclaw_login')).toEqual([]);
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
    ['is unsigned (alg none)', { alg: 'none' as const }],
    ['is signed HS256 with the client secret as the key', { alg: 'HS256' as const }],
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
      expect(browser.cookiesWithPrefix(stack.origin, 'chemclaw_login')).toEqual([]);
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
    // Not ASCII: could not be written into a Location header, so it used to fail after the
    // sign-in had succeeded.
    ['/日本語', '/'],
    ['/caf\u00e9?q=\u00fc', '/'],
    ['/a b', '/'],
    // Longer than a return path may be.
    [`/${'a'.repeat(600)}`, '/'],
    // An encoded slash that decodes to an authority.
    ['%2F%2Fevil.example', '/'],
    // Dot segments a browser collapses into an authority.
    ['/.//evil.example', '/'],
    ['/..//evil.example', '/'],
    ['/%2e//evil.example', '/'],
    ['/%2E%2e//evil.example', '/'],
    ['/a/../..//evil.example', '/'],
    ['/a//b', '/'],
    ['/./x', '/'],
  ])('refuses %j and lands on the root', async (returnTo, expected) => {
    expect((await landing(returnTo)).startsWith(expected)).toBe(true);
    expect(await landing(returnTo)).toBe('/?signed_in=1');
  });

  it('still signs the person in when the return path is refused, with a session to show for it', async () => {
    for (const returnTo of ['/日本語', `/${'a'.repeat(600)}`]) {
      const browser = freshBrowser();
      const { res } = await stack.signIn('alice', returnTo, browser);
      expect(res.status).toBe(200);
      expect(browser.cookie(stack.origin, cookieName)).toBeDefined();
      expect(await (await browser.request(`${stack.origin}/auth/session`)).json()).toMatchObject({
        authenticated: true,
      });
    }
  });

  it('keeps an encoded path as it was written', async () => {
    expect(await landing('/open/%E6%97%A5?q=%2F')).toBe('/open/%E6%97%A5?q=%2F&signed_in=1');
  });

  it('keeps a path on this origin, with its query', async () => {
    expect(await landing('/open/' + 'f'.repeat(32) + '?x=1')).toBe(
      `/open/${'f'.repeat(32)}?x=1&signed_in=1`,
    );
  });
});

describe('the sealed sign-in cookie', () => {
  const PREFIX = 'chemclaw_login';

  /** Begin a sign-in; returns the authorize URL, the cookie's name and value. */
  async function begin(
    browser: Browser,
    returnTo = '/',
  ): Promise<{ authorize: URL; name: string; value: string }> {
    const res = await browser.request(
      `${stack.origin}/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
    );
    const authorize = new URL(res.headers.get('location') ?? '');
    const [name, cookie] = browser.cookiesWithPrefix(stack.origin, PREFIX).at(-1) ?? [
      '',
      { value: '', raw: '' },
    ];
    return { authorize, name, value: cookie.value };
  }

  /** The callback the provider would send the browser to for `authorize`. */
  async function callbackFor(authorize: URL): Promise<string> {
    const url = new URL(authorize);
    url.searchParams.set('person', 'alice');
    return (await new Browser().request(url.toString())).headers.get('location') ?? '';
  }

  it('stays well under the 4 kB a browser keeps, with the longest return path allowed', async () => {
    const { name, value } = await begin(freshBrowser(), `/${'a'.repeat(511)}`);
    expect(`${name}=${value}`.length).toBeLessThan(2_000);
    // Three at once, plus a session cookie, still fit a request header comfortably.
    expect(3 * `${name}=${value}`.length + 100).toBeLessThan(8_000);
  });

  it('is refused when one byte of it is changed', async () => {
    const browser = freshBrowser();
    const { authorize, name, value } = await begin(browser);
    const callback = await callbackFor(authorize);
    const flipped = value.slice(0, 40) + (value[40] === 'A' ? 'B' : 'A') + value.slice(41);
    browser.jar.get(new URL(stack.origin).host)?.set(name, { value: flipped, raw: '' });
    expect((await browser.request(callback)).status).toBe(400);
    expect(browser.cookie(stack.origin, cookieName)).toBeUndefined();
  });

  it('is refused under another sign-in’s name, so it cannot be moved', async () => {
    const browser = freshBrowser();
    const first = await begin(browser);
    const second = await begin(browser);
    const callback = await callbackFor(second.authorize);
    browser.jar.get(new URL(stack.origin).host)?.set(second.name, { value: first.value, raw: '' });
    expect((await browser.request(callback)).status).toBe(400);
  });

  it('is refused when presented again after the callback was taken (replay)', async () => {
    const browser = freshBrowser();
    const { authorize, name, value } = await begin(browser);
    const callback = await callbackFor(authorize);
    expect((await browser.request(callback)).status).toBe(302);

    // Somebody who kept the cookie's value presents it again with the same callback.
    const replayer = freshBrowser();
    replayer.jar.set(new URL(stack.origin).host, new Map([[name, { value, raw: '' }]]));
    const replay = await replayer.request(callback);
    expect(replay.status).toBe(400);
    expect(replayer.cookie(stack.origin, cookieName)).toBeUndefined();
  });

  it('expires', async () => {
    const quick = await startStack({ env: { LOGIN_STATE_TTL_SECONDS: '1' } });
    try {
      const browser = freshBrowser();
      const res = await browser.request(`${quick.origin}/auth/login`);
      const authorize = new URL(res.headers.get('location') ?? '');
      authorize.searchParams.set('person', 'alice');
      const callback =
        (await freshBrowser().request(authorize.toString())).headers.get('location') ?? '';
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      expect((await browser.request(callback)).status).toBe(400);
    } finally {
      await quick.stop();
    }
  });

  it('lets two tabs sign in at once, each with its own cookie, and keeps at most three', async () => {
    const browser = freshBrowser();
    const one = await begin(browser, '/one');
    const two = await begin(browser, '/two');
    expect(browser.cookiesWithPrefix(stack.origin, PREFIX)).toHaveLength(2);

    // The first tab's callback arrives after the second began: it still lands on its own page.
    const back = await browser.request(await callbackFor(one.authorize));
    expect(new URL(back.headers.get('location') ?? '', stack.origin).pathname).toBe('/one');
    const other = await browser.request(await callbackFor(two.authorize));
    expect(new URL(other.headers.get('location') ?? '', stack.origin).pathname).toBe('/two');
  });

  it('holds six at once, refuses a seventh rather than drop a sign-in younger than 30 s', async () => {
    const crowded = freshBrowser();
    const starts = [];
    for (let i = 0; i < 6; i += 1) starts.push(await begin(crowded, `/${i}`));
    expect(crowded.cookiesWithPrefix(stack.origin, PREFIX)).toHaveLength(6);

    // A page forcing navigations to /auth/login cannot push the first one out from under its owner.
    const seventh = await crowded.request(`${stack.origin}/auth/login`);
    expect(seventh.status).toBe(429);
    expect(seventh.headers.get('retry-after')).toBe('30');
    expect(crowded.cookiesWithPrefix(stack.origin, PREFIX)).toHaveLength(6);
    expect((await crowded.request(await callbackFor(starts[0]!.authorize))).status).toBe(302);

    // One slot free again: a new sign-in is accepted.
    expect((await crowded.request(`${stack.origin}/auth/login`)).status).toBe(302);
  });

  it('keeps the whole Cookie header under 8 kB with six sign-ins of the longest return path', async () => {
    const browser = freshBrowser();
    for (let i = 0; i < 6; i += 1) await begin(browser, `/${'a'.repeat(511)}`);
    const header = [...browser.cookies(stack.origin)].map(([k, c]) => `${k}=${c.value}`).join('; ');
    expect(header.length).toBeLessThan(7_500);
  });

  it('drops the oldest once it is old enough, and clears expired ones', async () => {
    const quick = await startStack({ env: { LOGIN_STATE_TTL_SECONDS: '4' } }); // minimum age 2 s
    try {
      const browser = freshBrowser();
      const first = await browser.request(`${quick.origin}/auth/login`);
      const firstName = browser.cookiesWithPrefix(quick.origin, PREFIX)[0]?.[0] ?? '';
      expect(first.status).toBe(302);
      for (let i = 0; i < 5; i += 1) await browser.request(`${quick.origin}/auth/login`);
      expect(browser.cookiesWithPrefix(quick.origin, PREFIX)).toHaveLength(6);

      await new Promise((resolve) => setTimeout(resolve, 2_300));
      expect((await browser.request(`${quick.origin}/auth/login`)).status).toBe(302);
      expect(browser.cookiesWithPrefix(quick.origin, PREFIX)).toHaveLength(6);
      expect(browser.cookie(quick.origin, firstName)).toBeUndefined();

      await new Promise((resolve) => setTimeout(resolve, 4_200)); // all expired now
      await browser.request(`${quick.origin}/auth/login`);
      expect(browser.cookiesWithPrefix(quick.origin, PREFIX)).toHaveLength(1);
    } finally {
      await quick.stop();
    }
  }, 20_000);
});

describe('an anonymous flood of sign-ins', () => {
  it('cannot stop a different browser from signing in, and keeps nothing on the server', async () => {
    const flood = Array.from({ length: 1_500 }, () =>
      fetch(`${stack.bffUrl}/auth/login`, { redirect: 'manual' }),
    );
    const answers = await Promise.all(flood);
    expect(answers.every((r) => r.status === 302)).toBe(true);

    const browser = freshBrowser();
    const { res } = await stack.signIn('alice', '/', browser);
    expect(res.status).toBe(200);
    expect(browser.cookie(stack.origin, cookieName)).toBeDefined();
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
        /^__Host-chemclaw_login_[A-Za-z0-9_-]{22}=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=600$/,
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

describe('bogus callbacks against the provider’s token endpoint', () => {
  it('never exceed the in-flight cap, are told to retry, and do not block a sign-in that comes after', async () => {
    const capped = await startStack({ env: { OIDC_MAX_INFLIGHT: '4' } });
    try {
      capped.idp.behaviour.tokenDelayMs = 150;
      const before = capped.idp.tokenRequests.length;

      const attempts = Array.from({ length: 40 }, async () => {
        const browser = freshBrowser();
        const login = await browser.request(`${capped.origin}/auth/login`);
        const state = new URL(login.headers.get('location') ?? '').searchParams.get('state') ?? '';
        return browser.request(
          `${capped.origin}/auth/callback?state=${state}&code=not-a-code-${Math.random()}`,
        );
      });
      const answers = await Promise.all(attempts);

      // Four at a time at the most reached the provider, however many arrived.
      expect(capped.idp.calls.maxTokenConcurrency).toBeLessThanOrEqual(4);
      const busy = answers.filter((r) => r.status === 503);
      expect(busy.length).toBeGreaterThan(0);
      expect(busy.every((r) => r.headers.get('retry-after') === '5')).toBe(true);
      expect(answers.every((r) => r.status === 503 || r.status === 403)).toBe(true);
      expect(capped.idp.tokenRequests.length - before).toBeLessThan(40);

      // The flood is over; nobody is locked out.
      capped.idp.behaviour.tokenDelayMs = 0;
      const browser = freshBrowser();
      const { res } = await capped.signIn('alice', '/', browser);
      expect(res.status).toBe(200);
      expect(browser.cookie(capped.origin, cookieName)).toBeDefined();

      // And it is countable, by reason, without a label anyone can mint.
      const metrics = await (await fetch(`${capped.metricsUrl}/metrics`)).text();
      expect(metrics).toMatch(/chemclaw_ui_login_failures_total\{reason="busy"\} [1-9]/);
      expect(metrics).toMatch(
        /chemclaw_ui_login_failures_total\{reason="exchange_rejected"\} [1-9]/,
      );
      expect(metrics).not.toContain('not-a-code');
    } finally {
      await capped.stop();
    }
  });
});
