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
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import { AUTHORITY, UPSTREAM } from '../playwright.oidc-mock.config.ts';

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
