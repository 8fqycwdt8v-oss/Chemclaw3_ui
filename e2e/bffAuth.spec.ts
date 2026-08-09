/**
 * Sign-in under BFF token custody, in a real browser.
 *
 * The server side of this flow is covered exhaustively by `tests/bffAuthFlow.test.ts`. What only a
 * browser can answer is whether the cookies actually work: `SameSite=Lax` has to be sent on the
 * cross-site return leg from the identity provider and withheld on a cross-site POST, and no test
 * that constructs its own `Cookie` header can check either. This spec is also the only coverage of
 * `src/auth/bffAuth.ts`.
 */

import { expect, test } from '@playwright/test';

test('the app boots signed out and offers a way in', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Configuration error')).toHaveCount(0);
  // The dev-mode badge must not appear: this deployment requires sign-in.
  await expect(page.getByText('dev auth — no sign-in')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('completes the redirect round trip and comes back signed in', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Browser -> BFF -> mock Entra -> BFF -> back here, all as real navigations.
  await expect(page.getByText('End To End')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
});

test('the browser never receives the access token', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('End To End')).toBeVisible();

  // The session cookie is httpOnly, so script cannot read it — this is the property the whole mode
  // exists for, and it is the one an XSS would otherwise defeat.
  const readable = await page.evaluate(() => document.cookie);
  expect(readable).not.toContain('ccs0');
  expect(readable).not.toContain('e2e-access-token');
  // Only the CSRF token is meant to be readable.
  expect(readable).toContain('ccx=');

  // And it is not hiding in web storage either, which is where `msal-spa` keeps it.
  const stored = await page.evaluate(() =>
    JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
  );
  expect(stored).not.toContain('e2e-access-token');

  const cookies = await context.cookies();
  expect(cookies.find((c) => c.name === 'ccs0')?.httpOnly).toBe(true);
  expect(cookies.find((c) => c.name === 'ccx')?.httpOnly).toBe(false);
});

test('a signed-in session can drive a turn, with the BFF attaching the token', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('End To End')).toBeVisible();

  // A POST — so this exercises the CSRF path end to end: the SPA reads the `ccx` cookie and echoes
  // it in a header, and the BFF compares it against the copy sealed inside the session.
  await page.fill('textarea[aria-label="Message"]', 'What is the pKa of acetic acid?');
  await page.press('textarea[aria-label="Message"]', 'Enter');
  await expect(page.getByText('Acetic acid has a pKa of 4.76.')).toBeVisible();
});

test('a cross-site POST is refused even though the browser attaches the cookie', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('End To End')).toBeVisible();

  // Forge the shape of a CSRF: a same-origin request that omits the header, which is the most an
  // attacker on another origin could ever produce (they can cause the cookie to be sent, but
  // same-origin policy stops them reading it to build the header).
  const status = await page.evaluate(async () => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    return res.status;
  });
  expect(status).toBe(403);
});

test('signing out clears the session', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('End To End')).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  // Via the tenant's logout endpoint and back, so the identity provider's own session ends too.
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText('End To End')).toHaveCount(0);

  // And it stays signed out across a reload, i.e. the cookie really was cleared rather than the
  // page merely having forgotten.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});
