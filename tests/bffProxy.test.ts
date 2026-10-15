// @vitest-environment node

/**
 * What the BFF does to a request once somebody is signed in: refuse it if it could be forged,
 * inject the bearer, and never let the browser's own credentials through.
 *
 * Driven against the real listener with a stand-in Chemclaw service that validates the bearer the
 * way core's front door does (a token its provider issued, or 401) — so "the bearer was injected"
 * is the service accepting it, not a header being present.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Browser, SID, startStack } from './bffHarness.ts';
import type { Stack } from './bffHarness.ts';

let stack: Stack;
let browser: Browser;

const CSRF = { 'x-chemclaw-csrf': '1' };
const same = { ...CSRF, origin: '' };

beforeAll(async () => {
  stack = await startStack();
  same.origin = stack.origin;
});
afterAll(async () => {
  await stack.stop();
});
beforeEach(async () => {
  stack.core.seen.length = 0;
  stack.core.rejectNext = 0;
  stack.core.refused.clear();
  stack.core.delayMs = 0;
  stack.idp.behaviour.refreshFails = null;
  browser = new Browser();
  await stack.signIn('alice', '/', browser);
});

const lastSeen = () => stack.core.seen[stack.core.seen.length - 1];

describe('a signed-in request', () => {
  it('carries the session’s bearer, which the service accepts', async () => {
    const res = await browser.request(`${stack.origin}/api/sessions`, { headers: CSRF });
    expect(res.status).toBe(200);
    expect(lastSeen()?.headers.authorization).toBe(
      `Bearer ${stack.idp.accessTokens[stack.idp.accessTokens.length - 1]}`,
    );
  });

  it('never forwards a bearer the browser chose to send', async () => {
    const res = await browser.request(`${stack.origin}/api/sessions`, {
      headers: { ...CSRF, authorization: 'Bearer attacker-chosen-token' },
    });
    expect(res.status).toBe(200);
    expect(lastSeen()?.headers.authorization).not.toContain('attacker-chosen-token');
    expect(
      stack.core.seen.every((s) => !JSON.stringify(s.headers).includes('attacker-chosen')),
    ).toBe(true);
  });

  it('forwards no cookie and no x-chemclaw-* header from the browser', async () => {
    await browser.request(`${stack.origin}/api/sessions`, {
      headers: { ...CSRF, 'x-chemclaw-actor': 'somebody-else' },
    });
    const headers = lastSeen()?.headers ?? {};
    expect(headers.cookie).toBeUndefined();
    expect(headers['x-chemclaw-actor']).toBeUndefined();
    expect(headers['x-chemclaw-csrf']).toBeUndefined();
  });

  it('forwards a POST body and its answer intact', async () => {
    const res = await browser.request(`${stack.origin}/api/sessions`, {
      method: 'POST',
      headers: { ...same, 'content-type': 'application/json' },
      body: '{"profile":"default"}',
    });
    expect(await res.json()).toEqual({ session_id: SID });
    expect(lastSeen()?.body).toBe('{"profile":"default"}');
  });

  it.each([
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-real-ip',
    'forwarded',
    'x-original-url',
    'x-rewrite-url',
    'x-http-method',
    'x-http-method-override',
    'x-method-override',
  ])('does not forward %s from the browser', async (name) => {
    await browser.request(`${stack.origin}/api/sessions`, {
      headers: { ...CSRF, [name]: 'for=1.2.3.4' },
    });
    expect(lastSeen()?.headers[name]).toBeUndefined();
  });

  it('drops a Set-Cookie the service sends, so it cannot plant a cookie on this origin', async () => {
    const res = await browser.request(`${stack.origin}/api/sessions`, { headers: CSRF });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('needs no session for the probes, and sends them without any credential the browser chose', async () => {
    const res = await new Browser().request(`${stack.origin}/api/healthz`, {
      headers: { authorization: 'Bearer browser-chosen-token', cookie: 'x=1' },
    });
    expect(res.status).toBe(200);
    const probe = stack.core.seen.filter((s) => s.path === '/healthz').at(-1);
    expect(probe?.headers.authorization).toBeUndefined();
    expect(probe?.headers.cookie).toBeUndefined();
  });
});

describe('a request with no session', () => {
  it('is 401 session_required and never reaches the service', async () => {
    const res = await new Browser().request(`${stack.origin}/api/sessions`, { headers: CSRF });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'session_required' });
    expect(stack.core.seen.filter((s) => s.path === '/sessions')).toHaveLength(0);
  });

  it('is not rescued by a browser-supplied Authorization header', async () => {
    const res = await new Browser().request(`${stack.origin}/api/sessions`, {
      headers: { ...CSRF, authorization: `Bearer ${stack.idp.accessTokens[0]}` },
    });
    expect(res.status).toBe(401);
    expect(stack.core.seen.filter((s) => s.path === '/sessions')).toHaveLength(0);
  });
});

describe('cross-site requests', () => {
  it.each([
    ['a POST with no CSRF header', { method: 'POST', headers: { origin: '' } }],
    [
      'a POST from another origin',
      { method: 'POST', headers: { ...CSRF, origin: 'https://evil.example' } },
    ],
    ['a POST from the null origin', { method: 'POST', headers: { ...CSRF, origin: 'null' } }],
    [
      'a DELETE with no CSRF header',
      { method: 'DELETE', path: `/api/sessions/${SID}`, headers: {} },
    ],
    [
      'a POST the browser marks cross-site',
      { method: 'POST', headers: { ...same, 'sec-fetch-site': 'cross-site' } },
    ],
    [
      'a POST the browser marks same-site',
      { method: 'POST', headers: { ...same, 'sec-fetch-site': 'same-site' } },
    ],
  ])('refuses %s', async (_what, spec) => {
    const { path = '/api/sessions', ...init } = spec as { path?: string } & RequestInit;
    const headers = { ...(init.headers as Record<string, string>) };
    if (headers.origin === '') headers.origin = stack.origin;
    const res = await browser.request(`${stack.origin}${path}`, {
      ...init,
      headers,
      body: init.method === 'POST' ? '{}' : undefined,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'csrf' });
    expect(stack.core.seen.filter((s) => s.path.startsWith('/sessions'))).toHaveLength(0);
  });

  it('refuses even a GET the browser marks cross-site', async () => {
    const res = await browser.request(`${stack.origin}/api/sessions`, {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(res.status).toBe(403);
  });

  it('lets a same-origin POST through with the header, and a GET without it', async () => {
    const post = await browser.request(`${stack.origin}/api/sessions`, {
      method: 'POST',
      headers: { ...same, 'sec-fetch-site': 'same-origin' },
      body: '{}',
    });
    expect(post.status).toBe(200);
    const get = await browser.request(`${stack.origin}/api/sessions`, { headers: CSRF });
    expect(get.status).toBe(200);
  });

  it.each(['/api/sessions', '/api/digests', '/api/check-ins', `/api/sessions/${SID}/events`])(
    'refuses a GET of %s without the header — a plain <img src> or link cannot send one',
    async (path) => {
      const res = await browser.request(`${stack.origin}${path}`);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'csrf' });
      expect(stack.core.seen.filter((s) => s.path === path.replace('/api', ''))).toHaveLength(0);
    },
  );

  it('still lets a read of the session answer without it: it consumes nothing', async () => {
    expect((await browser.request(`${stack.origin}/auth/session`)).status).toBe(200);
  });

  it('refuses a cross-site read of the session, and a logout without the header', async () => {
    const read = await browser.request(`${stack.origin}/auth/session`, {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(read.status).toBe(403);
    const logout = await browser.request(`${stack.origin}/auth/logout`, { method: 'POST' });
    expect(logout.status).toBe(403);
    // And the session survived the forged logout.
    expect(await (await browser.request(`${stack.origin}/auth/session`)).json()).toMatchObject({
      authenticated: true,
    });
  });

  it('answers GET on /auth/logout with 405, so a link or image cannot sign anyone out', async () => {
    const res = await browser.request(`${stack.origin}/auth/logout`);
    expect(res.status).toBe(405);
  });
});

describe('the turn stream', () => {
  it('reaches the browser frame by frame, under the injected bearer', async () => {
    const cookie = [...browser.cookies(stack.origin)].map(([k, c]) => `${k}=${c.value}`).join('; ');
    const res = await fetch(`${stack.bffUrl}/api/sessions/${SID}/turn/stream`, {
      headers: { cookie, accept: 'text/event-stream', ...CSRF },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const arrivals: number[] = [];
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const started = Date.now();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arrivals.push(Date.now() - started);
      text += new TextDecoder().decode(value);
    }
    expect(text.match(/event: token/g)).toHaveLength(3);
    // Incremental: the last frame arrived well after the first (the service spaces them 60 ms).
    expect(arrivals.length).toBeGreaterThanOrEqual(2);
    expect((arrivals[arrivals.length - 1] ?? 0) - (arrivals[0] ?? 0)).toBeGreaterThan(60);
    expect(lastSeen()?.headers.authorization).toMatch(/^Bearer /);
  });

  it('is started by a POST that carries the bearer too', async () => {
    const cookie = [...browser.cookies(stack.origin)].map(([k, c]) => `${k}=${c.value}`).join('; ');
    const res = await fetch(`${stack.bffUrl}/api/sessions/${SID}/messages`, {
      method: 'POST',
      headers: { cookie, ...same, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: '{"message":"hi","dry_run":false,"exhibit_refs":[]}',
    });
    expect(res.status).toBe(200);
    expect((await res.text()).match(/event: token/g)).toHaveLength(3);
    expect(lastSeen()?.body).toContain('"message":"hi"');
  });
});

describe('a 401 from the service', () => {
  it('renews the token once and replays the request', async () => {
    const before = stack.idp.calls.refreshes;
    stack.core.rejectNext = 1;
    const res = await browser.request(`${stack.origin}/api/sessions`, { headers: CSRF });

    expect(res.status).toBe(200);
    expect(stack.idp.calls.refreshes).toBe(before + 1);
    const attempts = stack.core.seen.filter((s) => s.path === '/sessions');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.headers.authorization).not.toBe(attempts[1]?.headers.authorization);
  });

  it('replays a POST with the same body', async () => {
    stack.core.rejectNext = 1;
    const res = await browser.request(`${stack.origin}/api/sessions`, {
      method: 'POST',
      headers: { ...same, 'content-type': 'application/json' },
      body: '{"profile":"x"}',
    });
    expect(res.status).toBe(200);
    const attempts = stack.core.seen.filter((s) => s.method === 'POST');
    expect(attempts.map((a) => a.body)).toEqual(['{"profile":"x"}', '{"profile":"x"}']);
  });

  it('renews once for a burst of requests refused with the same token', async () => {
    const before = stack.idp.calls.refreshes;
    stack.core.refused.add(stack.idp.accessTokens[stack.idp.accessTokens.length - 1] ?? '');
    stack.core.delayMs = 30;
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        browser.request(`${stack.origin}/api/sessions`, { headers: CSRF }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(stack.idp.calls.refreshes - before).toBe(1);
  });

  it('answers session_expired when the token cannot be renewed, and ends the session', async () => {
    stack.core.rejectNext = 1;
    stack.idp.behaviour.refreshFails = 'invalid_grant';
    const res = await browser.request(`${stack.origin}/api/sessions`, { headers: CSRF });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'session_expired' });
    // The refresh token was refused, so there is no session left to ride on.
    const next = await browser.request(`${stack.origin}/api/sessions`, { headers: CSRF });
    expect(next.status).toBe(401);
    expect(await next.json()).toMatchObject({ code: 'session_required' });
  });

  it('does not renew again at once when a fresh token is refused too', async () => {
    const before = stack.idp.calls.refreshes;
    stack.core.rejectNext = 4;
    const first = await browser.request(`${stack.origin}/api/sessions`, { headers: CSRF });
    expect(first.status).toBe(401);
    const second = await browser.request(`${stack.origin}/api/sessions`, { headers: CSRF });
    expect(second.status).toBe(401);
    expect(stack.idp.calls.refreshes - before).toBe(1);
  });

  it('is not replayed for an upload, which is streamed and cannot be sent twice', async () => {
    const before = stack.idp.calls.refreshes;
    stack.core.rejectNext = 1;
    const res = await browser.request(`${stack.origin}/api/sessions/${SID}/attachments`, {
      method: 'POST',
      headers: { ...same, 'content-type': 'multipart/form-data; boundary=x' },
      body: '--x--',
    });
    expect(res.status).toBe(401);
    expect(stack.idp.calls.refreshes).toBe(before);
    expect(stack.core.seen.filter((s) => s.path.endsWith('/attachments'))).toHaveLength(1);
  });
});

describe('a stream under a session that ends', () => {
  const cookieOf = () =>
    [...browser.cookies(stack.origin)].map(([k, c]) => `${k}=${c.value}`).join('; ');

  async function openEvents(): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const res = await fetch(`${stack.bffUrl}/api/sessions/${SID}/events`, {
      headers: { cookie: cookieOf(), accept: 'text/event-stream', ...CSRF },
    });
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // the first frame: it is live
    await vi.waitFor(() => expect(stack.core.openStreams).toBe(1));
    return reader;
  }

  /** Whether the reader ends (done or an error) within `ms`. */
  const ends = (reader: ReadableStreamDefaultReader<Uint8Array>, ms: number): Promise<boolean> =>
    Promise.race([
      (async () => {
        try {
          for (;;) if ((await reader.read()).done) return true;
        } catch {
          return true;
        }
      })(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
    ]);

  it('ends promptly at sign-out, and the request to the service is destroyed', async () => {
    const reader = await openEvents();
    const out = await browser.request(`${stack.origin}/auth/logout`, {
      method: 'POST',
      headers: { ...same },
    });
    expect(out.status).toBe(200);

    expect(await ends(reader, 1_500), 'the stream was still open after sign-out').toBe(true);
    await vi.waitFor(() => expect(stack.core.openStreams).toBe(0));
  });

  it('ends when the provider refuses the refresh token that backs it', async () => {
    const reader = await openEvents();
    stack.idp.behaviour.refreshFails = 'invalid_grant';
    // Another request in the same session finds it unrenewable after a backend refusal.
    stack.core.rejectNext = 1;
    await browser.request(`${stack.origin}/api/sessions`, { headers: CSRF });

    expect(await ends(reader, 1_500), 'the stream outlived its session').toBe(true);
    await vi.waitFor(() => expect(stack.core.openStreams).toBe(0));
  });

  it('is untouched by another session ending', async () => {
    const reader = await openEvents();
    const other = new Browser();
    await stack.signIn('bob', '/', other);
    await other.request(`${stack.origin}/auth/logout`, { method: 'POST', headers: { ...same } });

    expect(await ends(reader, 600)).toBe(false);
    expect(stack.core.openStreams).toBe(1);
    await reader.cancel();
  });
});

describe('the whitelist is still the whitelist', () => {
  it('404s a route that is not listed, signed in or not', async () => {
    const res = await browser.request(`${stack.origin}/api/metrics`, { headers: CSRF });
    expect(res.status).toBe(404);
  });
});
