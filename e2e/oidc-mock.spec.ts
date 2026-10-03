/**
 * Two people sign in through a real authority, in two browsers, and each is who they said.
 *
 * Runs only under `playwright.oidc-mock.config.ts` (see there for the four processes and why the
 * tenant is https). The default suite ignores this file.
 *
 * What one sign-in proves, hop by hop: the SPA (production bundle, `AUTH_MODE=msal`) builds its
 * MSAL authority from `ENTRA_AUTHORITY` and is let through the CSP to it; the tenant's login page
 * issues a code; MSAL redeems it with its PKCE verifier and accepts the id_token's nonce; the
 * account MSAL reports is the person chosen; the page's `/api` calls carry a bearer; the BFF
 * forwards it; and a validator applying Chemclaw3's four checks accepts it as that person.
 * Two contexts rather than one, because "each sees their own identity" is only a claim about
 * isolation when there is someone else to be confused with.
 *
 * The last three tests are about the round trip itself rather than who comes out of it. #126 made
 * `/` the page a first sign-in returns to, and `Bootstrap` there pushed `/c/<new id>` before
 * `handleRedirectPromise()` had finished; MSAL redeems the code only while the address bar still
 * names the start page, so it went back to `/` and tried again, for ever — 534 navigations and no
 * token request in 20 s, measured here. Every test above failed on it too, as a timeout waiting for
 * the account name; these say *why*, and pin the deep-link and `/open/` cases besides.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import { AUTHORITY, BFF, UPSTREAM } from '../playwright.oidc-mock.config.ts';

interface Person {
  key: string;
  name: string;
  upn: string;
  oid: string;
}

const ALICE: Person = {
  key: 'alice',
  name: 'Alice Chemist',
  upn: 'alice@mock-tenant.test',
  oid: '00000000-0000-0000-0000-00000000a11c',
};
const BOB: Person = {
  key: 'bob',
  name: 'Bob Chemist',
  upn: 'bob@mock-tenant.test',
  oid: '00000000-0000-0000-0000-000000000b0b',
};

/** The claims of a JWT, unverified — what the page *sent*, checked against what the upstream saw. */
const claimsOf = (bearer: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(bearer.split('.')[1] ?? '', 'base64url').toString()) as Record<
    string,
    unknown
  >;

/** Open a fresh browser context and sign `person` in through the mock tenant's login page. */
async function signIn(browser: Browser, person: Person): Promise<Page> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });

  // No click: a signed-out visitor is sent to the authority by the SPA's first `/api` call
  // (`getAccessToken` -> `loginRedirect`). The "Sign in" button is visible for that moment too,
  // which is why waiting for it and clicking it races the navigation.
  await page.goto('/');
  const loginPage = page.getByTestId(`mock-login-${person.key}`);
  await expect(loginPage).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(new RegExp(`^${AUTHORITY.replace(/[.]/g, '\\.')}/`));
  await expect(page.getByText('TEST ONLY', { exact: false })).toBeVisible();
  await loginPage.click();

  // Back on the SPA, signed in. The account button carries the id_token's `name`.
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:4341\//);
  const account = page.getByRole('button', { name: 'Account and build details' });
  await expect(account, `console errors: ${problems.join(' | ')}`).toHaveText(person.name, {
    timeout: 20_000,
  });
  return page;
}

/** The bearer the page puts on its next `/api` request. */
async function nextBearer(page: Page): Promise<string> {
  const request = page.waitForRequest(
    (r) => r.url().includes('/api/') && !!r.headers().authorization,
  );
  await page.reload();
  const authorization = (await request).headers().authorization ?? '';
  expect(authorization).toMatch(/^Bearer /);
  return authorization.slice('Bearer '.length);
}

test('alice and bob sign in separately, and each sees and sends their own identity', async ({
  browser,
}) => {
  const alice = await signIn(browser, ALICE);
  const bob = await signIn(browser, BOB);

  // Each page shows its own person — and still does once the other has signed in.
  for (const [page, person, other] of [
    [alice, ALICE, BOB],
    [bob, BOB, ALICE],
  ] as const) {
    const account = page.getByRole('button', { name: 'Account and build details' });
    await expect(account).toHaveText(person.name);
    await account.click();
    await expect(page.getByText(person.upn)).toBeVisible();
    await expect(page.getByText(other.upn)).toHaveCount(0);
    await page.keyboard.press('Escape');
  }

  // What each page sends: a token for the API, naming its own person.
  const aliceBearer = claimsOf(await nextBearer(alice));
  const bobBearer = claimsOf(await nextBearer(bob));
  expect(aliceBearer).toMatchObject({ oid: ALICE.oid, aud: 'api://chemclaw', scp: 'Chat.Access' });
  expect(bobBearer).toMatchObject({ oid: BOB.oid, aud: 'api://chemclaw', scp: 'Chat.Access' });
  expect(aliceBearer.roles).toEqual(['chemist', 'reviewer']);
  expect(bobBearer.roles).toEqual(['chemist']);

  // What arrived on the far side of the BFF, validated the way Chemclaw3's front door validates:
  // both people, as themselves, and nothing refused.
  const { seen, refused } = (await (await fetch(`${UPSTREAM}/__oidc/seen`)).json()) as {
    seen: { oid: string; upn: string }[];
    refused: { path: string; reason: string }[];
  };
  expect(refused).toEqual([]);
  expect(seen.some((s) => s.oid === ALICE.oid && s.upn === ALICE.upn)).toBe(true);
  expect(seen.some((s) => s.oid === BOB.oid && s.upn === BOB.upn)).toBe(true);
});

test('signing out ends the session at the authority, and the next visit asks again', async ({
  browser,
}) => {
  const page = await signIn(browser, ALICE);
  const visited: string[] = [];
  // Navigation *requests*, not committed navigations: the end-session endpoint answers with a
  // redirect, which never commits a document of its own.
  page.on('request', (request) => {
    if (request.isNavigationRequest()) visited.push(request.url());
  });
  await page.getByRole('button', { name: 'Account and build details' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();

  // Out through the tenant's end-session endpoint and back to the SPA, signed out — so the SPA's
  // next sign-in lands on the login page again. Had the tenant's session survived, that sign-in
  // would have been a silent SSO straight back into alice and this page would never render.
  await expect(page.getByTestId('mock-login-bob')).toBeVisible({ timeout: 20_000 });
  expect(visited.some((url) => url.startsWith(`${AUTHORITY}/oauth2/v2.0/logout`))).toBe(true);
});

/**
 * What one sign-in did to the page, recorded from before the first navigation.
 *
 * `navigations` is every main-frame navigation, same-document ones included (a router push is
 * one), so a redirect loop shows up as a list that keeps growing. `redemptions` is every
 * authorization-code POST to the tenant's token endpoint: MSAL redeems a code exactly once, on the
 * start page, and only when the address bar still names that page — which is the comparison the
 * loop kept failing.
 */
interface SignInTrace {
  page: Page;
  navigations: string[];
  redemptions: number;
}

async function signInFrom(browser: Browser, person: Person, path: string): Promise<SignInTrace> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const trace: SignInTrace = { page, navigations: [], redemptions: 0 };
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) trace.navigations.push(frame.url());
  });
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().startsWith(`${AUTHORITY}/oauth2/v2.0/token`) &&
      /(^|&)grant_type=authorization_code(&|$)/.test(request.postData() ?? '')
    )
      trace.redemptions += 1;
  });

  await page.goto(path);
  const loginPage = page.getByTestId(`mock-login-${person.key}`);
  await expect(loginPage).toBeVisible({ timeout: 20_000 });
  await loginPage.click();
  try {
    await expect(page.getByRole('button', { name: 'Account and build details' })).toHaveText(
      person.name,
      { timeout: 20_000 },
    );
  } catch (error) {
    // A loop never shows the account at all, so say what the page was doing instead.
    const tail = trace.navigations.slice(-4).join(' -> ');
    throw new Error(
      `never signed in: ${trace.navigations.length} navigations, ${trace.redemptions} codes ` +
        `redeemed; last: ${tail}\n${String(error)}`,
    );
  }
  return trace;
}

/**
 * The page has stopped moving: the URL matches, and stays put — with no further navigation — for
 * a while longer than any redirect MSAL or the router would make. The loop this guards against ran
 * at ~50 navigations a second, so two seconds of stillness is not a close call either way.
 */
async function expectSettledAt(trace: SignInTrace, url: RegExp): Promise<string> {
  await expect(trace.page).toHaveURL(url, { timeout: 20_000 });
  const count = trace.navigations.length;
  const at = trace.page.url();
  await trace.page.waitForTimeout(2_000);
  expect(trace.page.url(), 'the URL moved again after the sign-in looked finished').toBe(at);
  expect(
    trace.navigations.slice(count),
    'the page kept navigating after the sign-in looked finished',
  ).toEqual([]);
  return at;
}

/** Exactly one code back on `/auth/callback`, and that one redeemed, for one sign-in. */
function expectOneRoundTrip(trace: SignInTrace): void {
  // Distinct URLs, because one arrival there is several navigation events: the document carrying
  // `#code=…`, then MSAL clearing the fragment from it in place.
  const codes = new Set(
    trace.navigations.filter((url) => url.startsWith(`${BFF}/auth/callback#code=`)),
  );
  expect([...codes], `navigations: ${trace.navigations.join(' -> ')}`).toHaveLength(1);
  expect(trace.redemptions, 'authorization codes redeemed').toBe(1);
  // Out to the tenant, back through the callback, to the start page, to where it leads: a handful.
  // The loop that shipped in #126 made 212 in 4 s.
  expect(
    trace.navigations.length,
    `navigations: ${trace.navigations.join(' -> ')}`,
  ).toBeLessThanOrEqual(12);
}

/** The signed-in person's persisted conversations, read from their own slot. */
async function persistedFor(
  page: Page,
  person: Person,
): Promise<Record<string, { sessionId?: string | null }>> {
  // The store's disk write is throttled (`PERSIST_THROTTLE_MS`, 750 ms); `expectSettledAt` has
  // already waited past it.
  const raw = await page.evaluate(
    (key) => window.localStorage.getItem(key),
    `chemclaw3.chat.v2.${person.oid}`,
  );
  expect(raw, `nothing persisted in ${person.key}'s own slot`).toBeTruthy();
  return (JSON.parse(raw ?? '{}') as { state: { conversations: Record<string, never> } }).state
    .conversations;
}

test('a first sign-in from / redeems one code, settles, and lands on the person’s own conversation', async ({
  browser,
}) => {
  const trace = await signInFrom(browser, ALICE, '/');
  const at = await expectSettledAt(trace, /^http:\/\/127\.0\.0\.1:4341\/c\/[^/]+$/);
  expectOneRoundTrip(trace);

  // Their own conversation, not the one minted in the anonymous slot before they signed in — the
  // "isn't on this device" panel #126 set out to remove.
  await expect(trace.page.getByText('That conversation isn’t on this device')).toHaveCount(0);
  const id = new URL(at).pathname.split('/')[2] ?? '';
  expect(Object.keys(await persistedFor(trace.page, ALICE))).toContain(id);
});

test('a sign-in started on a deep link returns to it', async ({ browser }) => {
  const trace = await signInFrom(browser, BOB, '/jobs');
  await expectSettledAt(trace, /^http:\/\/127\.0\.0\.1:4341\/jobs$/);
  expectOneRoundTrip(trace);
});

test('a signed-out visitor on an /open/ link signs in and lands on that conversation (#132)', async ({
  browser,
}) => {
  const sessionId = 'f'.repeat(32);
  const trace = await signInFrom(browser, ALICE, `/open/${sessionId}`);
  const at = await expectSettledAt(trace, /^http:\/\/127\.0\.0\.1:4341\/c\/[^/]+$/);
  expectOneRoundTrip(trace);

  // Adopted in the signed-in person's own slot, carrying the session the link named.
  const id = new URL(at).pathname.split('/')[2] ?? '';
  expect((await persistedFor(trace.page, ALICE))[id]?.sessionId).toBe(sessionId);
});

test('a sign-in started on a conversation link lands on the person’s own conversation (#126)', async ({
  browser,
}) => {
  // A `/c/<id>` minted in the anonymous slot is not in the person's own, so `signInStartPage`
  // returns them to `/` instead — the other half of the round trip the loop broke.
  const trace = await signInFrom(browser, BOB, '/c/00000000-0000-4000-8000-000000000000');
  const at = await expectSettledAt(trace, /^http:\/\/127\.0\.0\.1:4341\/c\/[^/]+$/);
  expectOneRoundTrip(trace);
  await expect(trace.page.getByText('That conversation isn’t on this device')).toHaveCount(0);
  const id = new URL(at).pathname.split('/')[2] ?? '';
  expect(Object.keys(await persistedFor(trace.page, BOB))).toContain(id);
});
