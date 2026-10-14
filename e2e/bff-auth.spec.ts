/**
 * Signing in through the BFF's token handler, in a real browser: login, an API call, a streamed
 * turn, renewal, and sign-out, against the fixture identity provider.
 *
 * The properties here are the ones a unit test cannot see because they are about the browser and
 * what it is *not* given: the session cookie is `HttpOnly` and `SameSite=Strict`, `document.cookie`
 * and both storages hold no token, no request the page makes carries an `Authorization` header, and
 * yet the service on the far side of the BFF validates a real bearer for the right person (the front
 * door in `e2e/oidc-upstream.ts` checks signature, issuer, audience and expiry as core does).
 *
 * Runs under the default `playwright.config.ts`, against the BFF it starts in `AUTH_MODE=bff` — the
 * only spec in the suite that signs in. Plain http on loopback, so the cookies are the unprefixed
 * pair; the `__Host-` flags are asserted over https in `tests/bffFlow.test.ts`. What this cannot
 * show — a cross-site redirect back to a `SameSite=Strict` cookie, a real Entra tenant — is listed in
 * `docs/operations.md`, "What a human verifies".
 */

import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { BFF_AUTH } from '../playwright.config.ts';

const { app: APP, idp: IDP, frontDoor: FRONT_DOOR } = BFF_AUTH;

// One provider and one front door are shared, and the assertions on their counters are about this
// file's own steps, so the tests run in order.
test.describe.configure({ mode: 'serial' });
test.use({ baseURL: APP });
test.skip(({ isMobile }) => isMobile, 'the sign-in is the same at either size');

const ALICE_OID = '00000000-0000-0000-0000-00000000a11c';
const SESSION_COOKIE = 'chemclaw_session';

/** A JWT of any kind, or one of the provider's opaque refresh tokens. */
const TOKEN_SHAPE = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.|rt-[A-Za-z0-9_-]{20,}/;

async function fixtureState(): Promise<{ calls: Record<string, number> }> {
  return (await (await fetch(`${IDP}/__fixture/state`)).json()) as {
    calls: Record<string, number>;
  };
}

async function frontDoorSeen(): Promise<{
  seen: { oid: string; path: string }[];
  refused: { path: string; reason: string }[];
}> {
  return (await (await fetch(`${FRONT_DOOR}/__oidc/seen`)).json()) as {
    seen: { oid: string; path: string }[];
    refused: { path: string; reason: string }[];
  };
}

/** Sign in as Alice from `/`: the SPA sends a signed-out visitor to the provider by itself. */
async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('fixture-login-alice')).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(new RegExp(`^${IDP.replace(/[.]/g, '\\.')}/`));
  await page.getByTestId('fixture-login-alice').click();
  await expect(page.getByRole('button', { name: 'Account and build details' })).toHaveText(
    'Alice Chemist',
    { timeout: 20_000 },
  );
}

/** What the page can read of its own credentials: all three places a token could be left. */
async function whatThePageHolds(page: Page): Promise<{
  cookie: string;
  local: string;
  session: string;
}> {
  return page.evaluate(() => ({
    cookie: document.cookie,
    local: JSON.stringify({ ...localStorage }),
    session: JSON.stringify({ ...sessionStorage }),
  }));
}

async function sessionCookie(context: BrowserContext) {
  return (await context.cookies(APP)).find((c) => c.name === SESSION_COOKIE);
}

test('a signed-out visitor is sent to the provider, signs in, and arrives holding no token', async ({
  page,
  context,
}) => {
  // Every request the page makes to the BFF, with the headers it chose to send.
  const requests: { url: string; authorization: string | undefined }[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith(APP)) {
      requests.push({ url: request.url(), authorization: request.headers().authorization });
    }
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await signIn(page);

  // Back on the page it started from, with the sign-in marker gone from the address bar.
  await expect(page).not.toHaveURL(/signed_in/);

  // The cookie: present, unreadable by script, and not sent cross-site.
  const cookie = await sessionCookie(context);
  expect(cookie, 'a session cookie').toBeDefined();
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
  expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);

  // Nothing the page can read is a credential.
  const held = await whatThePageHolds(page);
  expect(held.cookie).toBe('');
  expect(held.local).not.toMatch(TOKEN_SHAPE);
  expect(held.session).not.toMatch(TOKEN_SHAPE);

  // And no request it made carried one.
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.filter((r) => r.authorization)).toEqual([]);

  // Yet the service validated a real bearer, for Alice, on the calls the page made.
  await expect
    .poll(async () => (await frontDoorSeen()).seen.some((s) => s.oid === ALICE_OID), {
      message: 'the front door saw a validated bearer for alice',
    })
    .toBe(true);
  expect((await frontDoorSeen()).refused).toEqual([]);
  expect(errors).toEqual([]);

  // /config.js says the mode and nothing about the provider.
  const config = await (await page.request.get('/config.js')).text();
  expect(config).toContain('"authMode":"bff"');
  expect(config).not.toMatch(/fixture-tenant|chemclaw-bff-e2e|fixture-secret|api:\/\/chemclaw/);
});

test('a turn streams through the BFF under the session, frame by frame', async ({ page }) => {
  await signIn(page);
  await page.getByPlaceholder(/Ask about a reaction/).fill('What is the pKa of acetic acid?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  const answer = page.getByRole('article', { name: 'Assistant answer' }).last();
  const lengths: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    lengths.push(((await answer.textContent()) ?? '').length);
    await page.waitForTimeout(180);
  }
  expect(
    lengths.some((len, i) => i > 0 && len > (lengths[i - 1] ?? 0)),
    `the answer never grew mid-stream: ${lengths.join(' → ')}`,
  ).toBe(true);
  await expect(answer).toContainText('4.76', { timeout: 15_000 });

  // The turn itself reached the service with a validated bearer.
  const { seen, refused } = await frontDoorSeen();
  expect(seen.some((s) => s.oid === ALICE_OID && /\/messages$/.test(s.path))).toBe(true);
  expect(refused).toEqual([]);
});

test('the access token is renewed behind the page’s back, and nothing shows it', async ({
  page,
  context,
}) => {
  await signIn(page);
  const before = (await fixtureState()).calls.refreshes ?? 0;
  const cookieBefore = (await sessionCookie(context))?.value;

  // The provider mints a 6 s token and the BFF renews with 2 s left.
  await page.waitForTimeout(5_000);
  const reply = await page.evaluate(async () => {
    const res = await fetch('/api/sessions', { headers: { 'x-chemclaw-csrf': '1' } });
    return { status: res.status, text: await res.text() };
  });

  expect(reply.status).toBe(200);
  expect(reply.text).not.toMatch(TOKEN_SHAPE);
  await expect
    .poll(async () => ((await fixtureState()).calls.refreshes ?? 0) - before)
    .toBeGreaterThanOrEqual(1);
  // The browser's session did not change: same cookie, still signed in, no navigation.
  expect((await sessionCookie(context))?.value).toBe(cookieBefore);
  await expect(page.getByRole('button', { name: 'Account and build details' })).toHaveText(
    'Alice Chemist',
  );
  expect((await frontDoorSeen()).refused).toEqual([]);
});

test('a state-changing request without the CSRF header is refused, and a read still works', async ({
  page,
}) => {
  await signIn(page);
  const status = await page.evaluate(async () => {
    const forged = await fetch('/api/sessions', { method: 'POST', body: '{}' });
    const read = await fetch('/api/sessions');
    return { forged: forged.status, read: read.status };
  });
  expect(status).toEqual({ forged: 403, read: 200 });
});

test('signing out ends the session here and at the provider, and the next visit asks again', async ({
  page,
  context,
}) => {
  await signIn(page);
  const visited: string[] = [];
  page.on('request', (request) => {
    if (request.isNavigationRequest()) visited.push(request.url());
  });
  const ended = (await fixtureState()).calls.endSessions ?? 0;
  const revoked = (await fixtureState()).calls.revocations ?? 0;

  await page.getByRole('button', { name: 'Account and build details' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();

  // Out through the provider's end-session endpoint, back to the app — signed out, so the SPA
  // sends it to sign in again and the provider's login page shows.
  await expect(page.getByTestId('fixture-login-alice')).toBeVisible({ timeout: 20_000 });
  expect(visited.some((url) => url.startsWith(`${IDP}/fixture-tenant/oauth2/v2.0/logout`))).toBe(
    true,
  );
  expect((await fixtureState()).calls.endSessions).toBe(ended + 1);
  await expect.poll(async () => ((await fixtureState()).calls.revocations ?? 0) - revoked).toBe(1);

  expect(await sessionCookie(context)).toBeUndefined();
  const gone = await page.request.get(`${APP}/auth/session`);
  expect(await gone.json()).toEqual({ authenticated: false });
  const api = await page.request.get(`${APP}/api/sessions`);
  expect(api.status()).toBe(401);
});

test('a browser that comes back from the provider without a session stops, rather than looping', async ({
  page,
}) => {
  // The page asks who is signed in and is told nobody — what a browser that did not send the
  // cookie back experiences — on a load that carries the sign-in marker.
  await page.route('**/auth/session', (route) => route.fulfill({ json: { authenticated: false } }));
  let logins = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/auth/login') logins += 1;
  });

  await page.goto('/');
  await page.getByTestId('fixture-login-alice').click();

  await expect(page.getByRole('alert')).toContainText('did not keep the session', {
    timeout: 20_000,
  });
  await page.waitForTimeout(1_500);
  expect(logins).toBe(1); // the one that began it; no second trip to the provider
  await expect(page).toHaveURL(new RegExp(`^${APP.replace(/[.]/g, '\\.')}/`));
  await expect(page).not.toHaveURL(/signed_in/);
});
