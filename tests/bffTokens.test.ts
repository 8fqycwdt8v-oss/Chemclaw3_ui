// @vitest-environment node

/**
 * Token custody over time: renewal before expiry, one refresh however many requests ask, what a
 * refused or unreachable provider does to a session, and sign-out.
 *
 * Real clocks and short lifetimes (the fixture provider mints a 2-3 second access token and the BFF
 * is told to renew with 1-2.5 seconds left), because the property is "the right thing happens as
 * time passes" and a fake clock would test the test.
 */

import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureOidc } from '../e2e/fixture-oidc.ts';
import { OidcClient } from '../server/auth/oidc.ts';
import { SessionStore, SpentStates } from '../server/auth/sessions.ts';
import { Browser, CLIENT_ID, CLIENT_SECRET, SID, startStack } from './bffHarness.ts';
import type { Stack } from './bffHarness.ts';

const CSRF = { 'x-chemclaw-csrf': '1' };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('renewal before expiry', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({
      idp: { accessTtlSeconds: 2 },
      env: { TOKEN_REFRESH_SKEW_SECONDS: '1', TOKEN_REFRESH_BACKOFF_SECONDS: '1' },
    });
  });
  afterAll(async () => {
    await stack.stop();
  });
  afterEach(() => {
    stack.idp.behaviour.refreshFails = null;
    stack.idp.behaviour.tokenDelayMs = 0;
    stack.idp.behaviour.rotateRefreshTokens = false;
    stack.idp.behaviour.issueRefreshToken = true;
    stack.core.seen.length = 0;
  });

  const call = (browser: Browser) =>
    browser.request(`${stack.origin}/api/sessions`, { headers: CSRF });

  it('uses the token it has while it has time, then renews and uses the new one', async () => {
    const browser = new Browser();
    await stack.signIn('alice', '/', browser);
    const before = stack.idp.calls.refreshes;

    expect((await call(browser)).status).toBe(200);
    expect(stack.idp.calls.refreshes).toBe(before);
    const first = stack.core.seen.at(-1)?.headers.authorization;

    await sleep(1_200); // under a second left: inside the skew
    expect((await call(browser)).status).toBe(200);
    expect(stack.idp.calls.refreshes).toBe(before + 1);
    const second = stack.core.seen.at(-1)?.headers.authorization;
    expect(second).not.toBe(first);
    expect(second).toBe(`Bearer ${stack.idp.accessTokens.at(-1)}`);
  });

  it('refreshes once for a burst of requests that all find the token about to expire', async () => {
    const browser = new Browser();
    await stack.signIn('alice', '/', browser);
    await sleep(1_200);
    const before = stack.idp.calls.refreshes;
    stack.idp.behaviour.tokenDelayMs = 250; // long enough that all ten overlap with the first

    const results = await Promise.all(Array.from({ length: 10 }, () => call(browser)));

    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(stack.idp.calls.refreshes - before).toBe(1);
    const bearers = new Set(
      stack.core.seen.filter((s) => s.path === '/sessions').map((s) => s.headers.authorization),
    );
    expect(bearers.size).toBe(1);
  });

  it('shows the browser nothing of the renewal', async () => {
    const browser = new Browser();
    await stack.signIn('alice', '/', browser);
    await sleep(1_200);
    const res = await call(browser);
    const seen = `${[...res.headers].join()}${await res.text()}`;
    expect(seen).not.toContain(stack.idp.accessTokens.at(-1));
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('follows a provider that rotates refresh tokens', async () => {
    stack.idp.behaviour.rotateRefreshTokens = true;
    const browser = new Browser();
    await stack.signIn('alice', '/', browser);
    const before = stack.idp.tokenRequests.length;
    for (let round = 0; round < 2; round += 1) {
      await sleep(1_200);
      expect((await call(browser)).status).toBe(200);
    }
    const refreshes = stack.idp.tokenRequests
      .slice(before)
      .filter((r) => r.grant_type === 'refresh_token');
    expect(refreshes).toHaveLength(2);
    // The second used the token the first one returned, not the original (which is now spent).
    expect(refreshes[1]?.refresh_token).not.toBe(refreshes[0]?.refresh_token);
  });

  it('ends the session, with a 401 the page can act on, when the provider refuses the refresh token', async () => {
    const browser = new Browser();
    await stack.signIn('alice', '/', browser);
    await sleep(1_200);
    stack.idp.behaviour.refreshFails = 'invalid_grant';

    const res = await call(browser);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'session_expired' });
    expect(res.headers.get('set-cookie')).toMatch(/^chemclaw_session=; .*Max-Age=0/);
    expect(stack.core.seen.filter((s) => s.path === '/sessions')).toHaveLength(0);
    expect(await (await browser.request(`${stack.origin}/auth/session`)).json()).toEqual({
      authenticated: false,
    });
  });

  it('keeps the session and the request going on a token with time left when the provider is down', async () => {
    const browser = new Browser();
    await stack.signIn('alice', '/', browser);
    await sleep(1_200);
    stack.idp.behaviour.refreshFails = 'server_error';
    const before = stack.idp.calls.refreshes;

    expect((await call(browser)).status).toBe(200);
    // Inside the retry backoff the provider is left alone.
    expect((await call(browser)).status).toBe(200);
    expect((await call(browser)).status).toBe(200);
    expect(stack.idp.calls.refreshes - before).toBe(1);
    expect(await (await browser.request(`${stack.origin}/auth/session`)).json()).toMatchObject({
      authenticated: true,
    });
  });

  it('answers 503 and keeps the session when the token has run out and the provider is down', async () => {
    const browser = new Browser();
    await stack.signIn('alice', '/', browser);
    await sleep(2_200);
    stack.idp.behaviour.refreshFails = 'unreachable';
    const before = stack.idp.calls.refreshes;

    const res = await call(browser);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'idp_unavailable' });
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await (await browser.request(`${stack.origin}/auth/session`)).json()).toMatchObject({
      authenticated: true,
    });

    // Inside the backoff the provider is not asked again, however many requests arrive: an outage
    // costs one attempt per window, not one per wave.
    const wave = await Promise.all(Array.from({ length: 8 }, () => call(browser)));
    expect(wave.map((r) => r.status)).toEqual(Array(8).fill(503));
    expect(stack.idp.calls.refreshes - before).toBe(1);

    // The provider comes back and the window passes (1 s here): the next request recovers.
    stack.idp.behaviour.refreshFails = null;
    await sleep(1_100);
    expect((await call(browser)).status).toBe(200);
  });

  it('does not send an upload for a session that ended while its bearer was being renewed', async () => {
    const browser = new Browser();
    await stack.signIn('alice', '/', browser);
    await sleep(1_200); // inside the skew: the next request renews first
    stack.idp.behaviour.tokenDelayMs = 600;

    const upload = browser.request(`${stack.origin}/api/sessions/${SID}/attachments`, {
      method: 'POST',
      headers: { ...CSRF, origin: stack.origin },
      // No body: the case where the stream is already at its end when the request is built.
    });
    await sleep(200);
    // The person signs out while the renewal is still running.
    const out = await browser.request(`${stack.origin}/auth/logout`, {
      method: 'POST',
      headers: { ...CSRF, origin: stack.origin },
    });
    expect(out.status).toBe(200);

    const res = await upload;
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'session_expired' });
    expect(res.headers.get('set-cookie')).toMatch(/^chemclaw_session=; .*Max-Age=0/);
    // Nothing went upstream under the ended session (given time to arrive, were it going to), and
    // the process is still serving.
    await sleep(400);
    expect(stack.core.seen.filter((s) => s.path.endsWith('/attachments'))).toHaveLength(0);
    expect((await new Browser().request(`${stack.origin}/auth/session`)).status).toBe(200);
  });

  it('ends a session whose provider issued no refresh token when its access token runs out', async () => {
    stack.idp.behaviour.issueRefreshToken = false;
    const browser = new Browser();
    await stack.signIn('alice', '/', browser);
    expect((await call(browser)).status).toBe(200);

    await sleep(2_200);
    const res = await call(browser);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'session_expired' });
  });
});

describe('sign-out', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(async () => {
    await stack.stop();
  });

  const logout = (browser: Browser) =>
    browser.request(`${stack.origin}/auth/logout`, {
      method: 'POST',
      headers: { ...CSRF, origin: stack.origin },
    });

  it('ends the session here, clears the cookie, and revokes the refresh token', async () => {
    const browser = new Browser();
    await stack.signIn('alice', '/', browser);
    const cookie = browser.cookie(stack.origin, 'chemclaw_session')?.value ?? '';
    const revoked = stack.idp.calls.revocations;

    const res = await logout(browser);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(
      /^chemclaw_session=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0$/,
    );
    expect(browser.cookie(stack.origin, 'chemclaw_session')).toBeUndefined();

    for (let i = 0; i < 20 && stack.idp.calls.revocations === revoked; i += 1) await sleep(50);
    expect(stack.idp.calls.revocations).toBe(revoked + 1);
    expect([...stack.idp.revoked].some((t) => t.startsWith('rt-'))).toBe(true);

    // The cookie it held is worth nothing now, wherever it is replayed.
    const replay = new Browser();
    replay.jar.set(
      new URL(stack.origin).host,
      new Map([['chemclaw_session', { value: cookie, raw: '' }]]),
    );
    expect(await (await replay.request(`${stack.origin}/auth/session`)).json()).toEqual({
      authenticated: false,
    });
    expect((await replay.request(`${stack.origin}/api/sessions`, { headers: CSRF })).status).toBe(
      401,
    );
  });

  it('tells the page where to end the provider’s session, with no token in the URL', async () => {
    const browser = new Browser();
    await stack.signIn('alice', '/', browser);
    const body = (await (await logout(browser)).json()) as { endSessionUrl: string };

    const url = new URL(body.endSessionUrl);
    expect(url.origin + url.pathname).toBe(`${stack.idp.authority}/oauth2/v2.0/logout`);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(`${stack.origin}/`);
    expect(body.endSessionUrl).not.toMatch(/eyJ|rt-|id_token_hint/);

    // Following it ends the provider's session and comes back to the app.
    const ended = stack.idp.calls.endSessions;
    const { res, chain } = await browser.navigate(body.endSessionUrl);
    expect(stack.idp.calls.endSessions).toBe(ended + 1);
    expect(chain[chain.length - 1]).toBe(`${stack.origin}/`);
    expect(res.status).toBe(200);
  });

  it('does not offer the provider’s end-session endpoint to an unknown redirect', async () => {
    const res = await new Browser().request(
      `${stack.idp.authority}/oauth2/v2.0/logout?client_id=${CLIENT_ID}&post_logout_redirect_uri=https://evil.example/`,
    );
    expect(res.status).toBe(200); // shown "signed out", never redirected
  });

  it('is harmless with no session, and still says where to go', async () => {
    const res = await logout(new Browser());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { endSessionUrl: string }).endSessionUrl).toContain(
      '/oauth2/v2.0/logout',
    );
  });

  it('offers no provider sign-out when ENTRA_END_SESSION=false', async () => {
    const quiet = await startStack({ env: { ENTRA_END_SESSION: 'false' } });
    try {
      const browser = new Browser();
      await quiet.signIn('alice', '/', browser);
      const res = await browser.request(`${quiet.origin}/auth/logout`, {
        method: 'POST',
        headers: { ...CSRF, origin: quiet.origin },
      });
      expect(await res.json()).toEqual({ endSessionUrl: null });
    } finally {
      await quiet.stop();
    }
  });
});

describe('the sessions gauge on /metrics', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(async () => {
    await stack.stop();
  });

  const gauge = async (): Promise<number> => {
    const body = await (await fetch(`${stack.bffUrl}/metrics`)).text();
    return Number(/^chemclaw_ui_sessions (\d+)$/m.exec(body)?.[1]);
  };

  it('is the number of people signed in on this pod, down again as they sign out', async () => {
    expect(await gauge()).toBe(0);
    const [alice, bob] = [new Browser(), new Browser()];
    await stack.signIn('alice', '/', alice);
    await stack.signIn('bob', '/', bob);
    expect(await gauge()).toBe(2);

    await alice.request(`${stack.origin}/auth/logout`, {
      method: 'POST',
      headers: { ...CSRF, origin: stack.origin },
    });
    expect(await gauge()).toBe(1);
  });
});

describe('a public client (ENTRA_CLIENT_AUTH=none)', () => {
  it('signs in with PKCE alone and sends no secret', async () => {
    const stack = await startStack({
      idp: { clientSecret: null },
      env: { ENTRA_CLIENT_AUTH: 'none', ENTRA_CLIENT_SECRET: '' },
    });
    try {
      const browser = new Browser();
      const { res } = await stack.signIn('alice', '/', browser);
      expect(res.status).toBe(200);
      expect(stack.idp.tokenRequests.every((r) => r.client_secret === undefined)).toBe(true);
    } finally {
      await stack.stop();
    }
  });
});

describe('the session store', () => {
  const limits = { idleMs: 1_000, maxAgeMs: 5_000, maxSessions: 3 };
  const fresh = (token = 't') => ({
    account: { id: 'u', username: 'u', name: 'U', roles: [] },
    accessToken: token,
    accessExpiresAt: 0,
    refreshToken: null,
  });
  let clock = 0;
  const make = () => {
    clock = 0;
    return new SessionStore(limits, () => clock);
  };

  it('ends a session unused for the idle time, and one older than the absolute time however used', () => {
    const store = make();
    const idle = store.create(fresh());
    const busy = store.create(fresh());
    clock = 900;
    expect(store.get(busy.id)).toBeDefined();
    clock = 1_500; // idle: 1500 since creation and last use; busy: 600 since last use
    expect(store.get(idle.id)).toBeUndefined();
    for (let t = 1_400; t <= 4_900; t += 500) {
      clock = t;
      expect(store.get(busy.id)).toBeDefined();
    }
    clock = 5_100; // used a moment ago, but past the absolute lifetime
    expect(store.get(busy.id)).toBeUndefined();
    store.stop();
  });

  it('drops the least recently used session over the cap', () => {
    const store = make();
    const [a, b, c] = [
      store.create(fresh('a')),
      store.create(fresh('b')),
      store.create(fresh('c')),
    ];
    expect(store.get(a.id)).toBeDefined(); // a is now the most recent
    const d = store.create(fresh('d'));
    expect(store.size).toBe(3);
    expect(store.get(b.id)).toBeUndefined();
    for (const kept of [a, c, d]) expect(store.get(kept.id)).toBeDefined();
    store.stop();
  });

  it('counts as live only what is within both lifetimes, and ends nothing by counting', () => {
    const store = make();
    store.create(fresh());
    clock = 600;
    store.create(fresh());
    expect(store.live()).toBe(2);
    clock = 1_500; // the first is past the idle time; the sweep has not run
    expect(store.live()).toBe(1);
    expect(store.size).toBe(2);
    store.stop();
  });

  it('issues unguessable, distinct ids and never an empty one', () => {
    const store = make();
    const ids = new Set(Array.from({ length: 50 }, () => store.create(fresh()).id));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.get('')).toBeUndefined();
    store.stop();
  });
});

describe('spent sign-in states', () => {
  it('are spent once, and forgotten when their cookie would have expired', () => {
    let clock = 0;
    const spent = new SpentStates(1_000, 10, () => clock);
    expect(spent.spend('state-1')).toBe(true);
    expect(spent.spend('state-1')).toBe(false);
    expect(spent.spend('state-2')).toBe(true);
    clock = 1_500;
    expect(spent.spend('state-1')).toBe(true);
  });

  it('are bounded in number, oldest first', () => {
    const spent = new SpentStates(60_000, 3, () => 0);
    for (const state of ['s1', 's2', 's3', 's4']) spent.spend(state);
    expect(spent.spend('s4')).toBe(false);
    expect(spent.spend('s1')).toBe(true); // evicted
  });
});

describe('the live requests of a session', () => {
  const limits = { idleMs: 1_000, maxAgeMs: 5_000, maxSessions: 2 };
  const fresh = () => ({
    account: { id: 'u', username: 'u', name: 'U', roles: [] },
    accessToken: 't',
    accessExpiresAt: 0,
    refreshToken: null,
  });

  it('end when the session is deleted, expires, is swept, or is evicted — and not when it is merely used', () => {
    let clock = 0;
    const store = new SessionStore(limits, () => clock);
    const ended: string[] = [];
    const watch = (name: string, id: ReturnType<typeof store.create>) =>
      store.watch(id, () => ended.push(name));

    const deleted = store.create(fresh());
    watch('deleted', deleted);
    store.delete(deleted.id);

    const expired = store.create(fresh());
    watch('expired', expired);
    const used = store.create(fresh());
    watch('used', used);
    clock = 400;
    store.get(used.id); // touching re-inserts it; that is not an end
    expect(ended).toEqual(['deleted']);
    clock = 1_200;
    store.get(expired.id);
    expect(ended).toEqual(['deleted', 'expired']);

    store.sweep(); // used: 800 idle, kept at 1200? it was last seen at 400 -> 800 < 1000
    expect(ended).toEqual(['deleted', 'expired']);
    clock = 1_500;
    store.sweep();
    expect(ended).toEqual(['deleted', 'expired', 'used']);

    clock = 2_000;
    const a = store.create(fresh());
    watch('a', a);
    store.create(fresh());
    store.create(fresh()); // over the cap of two: the oldest goes
    expect(ended.at(-1)).toBe('a');
    store.stop();
  });

  it('can be withdrawn, and a watch on a session already gone is refused rather than attached', () => {
    const store = new SessionStore(limits, () => 0);
    const session = store.create(fresh());
    const ended: string[] = [];
    const withdraw = store.watch(session, () => ended.push('withdrawn'));
    withdraw?.();
    store.delete(session.id);
    expect(ended).toEqual([]);

    expect(store.watch(session, () => ended.push('late'))).toBeNull();
    expect(ended).toEqual([]);
    store.stop();
  });
});

describe('the provider’s signing keys', () => {
  it('are re-read when a token arrives signed with a key not yet seen (rotation)', async () => {
    const idp = await startFixtureOidc({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUris: ['http://127.0.0.1/cb'],
      postLogoutRedirectUris: [],
    });
    const oidc = new OidcClient({
      authority: idp.authority,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scope: 'openid',
      redirectUri: 'http://127.0.0.1/cb',
      postLogoutRedirectUri: 'http://127.0.0.1/',
      endSession: false,
      timeoutMs: 2_000,
      jwksCooldownMs: 0,
    });
    try {
      const idTokenFrom = async (): Promise<string> => {
        const verifier = 'v'.repeat(43);
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        const url = new URL(await oidc.authorizeUrl({ state: 's', nonce: 'nonce-1', challenge }));
        url.searchParams.set('person', 'alice');
        const back = new URL(
          (await fetch(url, { redirect: 'manual' })).headers.get('location') ?? '',
        );
        const tokens = await oidc.exchangeCode(back.searchParams.get('code') ?? '', verifier);
        return tokens.idToken ?? '';
      };

      const first = await idTokenFrom();
      expect((await oidc.verifyIdToken(first, 'nonce-1')).id).toBeTruthy();
      const fetches = idp.calls.jwks;

      await idp.rotateKey(); // the next token is signed with a key-2 the cached set lacks
      const second = await idTokenFrom();
      expect((await oidc.verifyIdToken(second, 'nonce-1')).name).toBe('Alice Chemist');
      expect(idp.calls.jwks).toBeGreaterThan(fetches);

      // And a nonce that is not this sign-in's is refused on a token that is otherwise perfect.
      await expect(oidc.verifyIdToken(second, 'another-nonce')).rejects.toMatchObject({
        oauthError: 'invalid_id_token',
      });
    } finally {
      await idp.close();
    }
  });
});

describe('the provider’s discovery document', () => {
  it('outlives a refresh the provider fails, and is asked for again a minute later, not per request', async () => {
    const idp = await startFixtureOidc({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUris: ['http://127.0.0.1/cb'],
      postLogoutRedirectUris: [],
    });
    let clock = 0;
    let broken = false;
    let asked = 0;
    const oidc = new OidcClient(
      {
        authority: idp.authority,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        scope: 'openid',
        redirectUri: 'http://127.0.0.1/cb',
        postLogoutRedirectUri: 'http://127.0.0.1/',
        endSession: false,
        timeoutMs: 2_000,
        fetchImpl: (input, init) => {
          asked += 1;
          return broken ? Promise.reject(new Error('down')) : fetch(input, init);
        },
      },
      () => clock,
    );
    try {
      const first = await oidc.discovery();
      expect(asked).toBe(1);

      clock = 3_700_000; // past the hour: due for a refresh, which fails
      broken = true;
      expect(await oidc.discovery()).toEqual(first);
      expect(asked).toBe(2);

      // Not again on every call while it is down...
      expect(await oidc.discovery()).toEqual(first);
      expect(asked).toBe(2);

      // ...but after a minute, yes — and it recovers.
      clock += 61_000;
      broken = false;
      await oidc.discovery();
      expect(asked).toBe(3);
    } finally {
      await idp.close();
    }
  });

  it('is an error, not a guess, when there has never been one', async () => {
    const oidc = new OidcClient({
      authority: 'http://127.0.0.1:9/nowhere',
      clientId: CLIENT_ID,
      clientSecret: null,
      scope: 'openid',
      redirectUri: 'http://127.0.0.1/cb',
      postLogoutRedirectUri: 'http://127.0.0.1/',
      endSession: false,
      timeoutMs: 500,
    });
    await expect(oidc.discovery()).rejects.toMatchObject({ name: 'IdpUnavailable' });
  });
});

describe('the endpoints discovery names', () => {
  const issuer = 'https://login.example/tenant/v2.0';
  const good = {
    issuer,
    authorization_endpoint: 'https://login.example/tenant/oauth2/v2.0/authorize',
    token_endpoint: 'https://login.example/tenant/oauth2/v2.0/token',
    jwks_uri: 'https://login.example/tenant/discovery/v2.0/keys',
    end_session_endpoint: 'https://login.example/tenant/oauth2/v2.0/logout',
  };
  const clientFor = (doc: Record<string, unknown>, endpointOrigins: string[] = []) =>
    new OidcClient({
      authority: 'https://login.example/tenant',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scope: 'openid',
      redirectUri: 'https://app.example/auth/callback',
      postLogoutRedirectUri: 'https://app.example/',
      endSession: true,
      timeoutMs: 500,
      endpointOrigins,
      fetchImpl: () => Promise.resolve(Response.json(doc)),
    });

  it('are accepted on the issuer’s origin', async () => {
    expect((await clientFor(good).discovery()).token_endpoint).toBe(good.token_endpoint);
  });

  it.each([
    ['token_endpoint', 'https://evil.example/token'],
    ['jwks_uri', 'https://evil.example/keys'],
    ['authorization_endpoint', 'https://evil.example/authorize'],
    ['end_session_endpoint', 'https://evil.example/logout'],
    ['revocation_endpoint', 'https://evil.example/revoke'],
  ])(
    'refuse a %s on another origin, where the client secret and the code would be sent',
    async (field, url) => {
      await expect(clientFor({ ...good, [field]: url }).discovery()).rejects.toMatchObject({
        name: 'IdpUnavailable',
      });
    },
  );

  it.each(['token_endpoint', 'jwks_uri'])('refuse a plain-http %s', async (field) => {
    await expect(
      clientFor({ ...good, [field]: 'http://login.example/x' }).discovery(),
    ).rejects.toMatchObject({ name: 'IdpUnavailable' });
  });

  it('accept an origin the operator listed, and only that one', async () => {
    const doc = { ...good, jwks_uri: 'https://keys.example/tenant/keys' };
    expect((await clientFor(doc, ['https://keys.example']).discovery()).jwks_uri).toBe(
      doc.jwks_uri,
    );
    await expect(clientFor(doc, ['https://other.example']).discovery()).rejects.toMatchObject({
      name: 'IdpUnavailable',
    });
  });

  it('are refused when a hostile document is consistent about being elsewhere', async () => {
    // Issuer and every endpoint on the attacker's host: self-consistent, and still not the
    // authority the operator configured.
    const hostile = {
      issuer: 'https://evil.example/tenant/v2.0',
      authorization_endpoint: 'https://evil.example/tenant/authorize',
      token_endpoint: 'https://evil.example/tenant/token',
      jwks_uri: 'https://evil.example/tenant/keys',
    };
    await expect(clientFor(hostile).discovery()).rejects.toMatchObject({ name: 'IdpUnavailable' });
  });

  it('are not checked when discovery does not name them (device code, userinfo and the like)', async () => {
    const doc = { ...good, userinfo_endpoint: 'https://graph.example/oidc/userinfo' };
    await expect(clientFor(doc).discovery()).resolves.toBeDefined();
  });
});

describe('a live stream is use of its session', () => {
  it('keeps a session whose only traffic is an open stream from idling out', async () => {
    const quiet = await startStack({ env: { SESSION_IDLE_MINUTES: '0.05' } }); // 3 s idle
    try {
      const browser = new Browser();
      await quiet.signIn('alice', '/', browser);
      const cookie = [...browser.cookies(quiet.origin)]
        .map(([k, c]) => `${k}=${c.value}`)
        .join('; ');
      const res = await fetch(`${quiet.bffUrl}/api/sessions/${SID}/events`, {
        headers: { cookie, accept: 'text/event-stream', ...CSRF },
      });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();

      await sleep(5_000); // longer than the idle time, with no other request
      expect(await (await browser.request(`${quiet.origin}/auth/session`)).json()).toMatchObject({
        authenticated: true,
      });
      expect(quiet.core.openStreams).toBe(1);
      await reader.cancel();
    } finally {
      await quiet.stop();
    }
  }, 20_000);
});

describe('the token endpoint’s rule about Origin', () => {
  const CSRF_ONLY = { 'x-chemclaw-csrf': '1' };

  it('is met by a public client, which names the app’s origin (Chemclaw3_mock’s single-page rule)', async () => {
    // The mock tenant redeems codes only for a request carrying a registered origin; a server
    // sending none was refused, and every sign-in in the oidc-mock lane ended at "refused".
    const stack = await startStack({
      idp: { clientSecret: null, tokenOriginPolicy: 'spa', accessTtlSeconds: 2 },
      env: { ENTRA_CLIENT_AUTH: 'none', ENTRA_CLIENT_SECRET: '', TOKEN_REFRESH_SKEW_SECONDS: '1' },
    });
    try {
      const browser = new Browser();
      const { res } = await stack.signIn('alice', '/', browser);
      expect(res.status).toBe(200);
      expect(browser.cookie(stack.origin, 'chemclaw_session')).toBeDefined();

      // The refresh goes to the same endpoint under the same rule.
      await sleep(1_200);
      const before = stack.idp.calls.refreshes;
      const api = await browser.request(`${stack.origin}/api/sessions`, { headers: CSRF_ONLY });
      expect(api.status).toBe(200);
      expect(stack.idp.calls.refreshes).toBe(before + 1);
    } finally {
      await stack.stop();
    }
  });

  it('is met by a Web client, which names none (Entra refuses one that does)', async () => {
    const stack = await startStack({
      idp: { tokenOriginPolicy: 'web', accessTtlSeconds: 2 },
      env: { TOKEN_REFRESH_SKEW_SECONDS: '1' },
    });
    try {
      const browser = new Browser();
      const { res } = await stack.signIn('alice', '/', browser);
      expect(res.status).toBe(200);
      await sleep(1_200);
      const api = await browser.request(`${stack.origin}/api/sessions`, { headers: CSRF_ONLY });
      expect(api.status).toBe(200);
      expect(stack.idp.tokenRequests.every((r) => r.client_secret === 'test-client-secret')).toBe(
        true,
      );
    } finally {
      await stack.stop();
    }
  });
});
