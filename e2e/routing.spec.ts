import { expect, test, type Page } from '@playwright/test';

/**
 * The URL is a projection of the store, and the store stays the source of truth.
 *
 * What is worth pinning here is the two failure modes the design has to avoid: the URL and the
 * store ping-ponging against each other, and a stale link silently redirecting somewhere else
 * instead of saying what happened.
 */

const SHARED_SID = 'b'.repeat(32);

test('lands on a conversation URL and keeps it across a reload', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/);

  const url = page.url();
  await page.reload();
  await expect(page).toHaveURL(url);
});

test('Back returns to the previous conversation', async ({ page, isMobile }) => {
  await page.goto('/');
  // `/` redirects, so wait for the conversation URL before reading it — otherwise `first` is the
  // bootstrap path and the assertion below compares against something no history entry holds.
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/);
  const first = page.url();

  // The sidebar column is gone below `lg`, so the button only exists inside the drawer there.
  if (isMobile) await page.getByRole('button', { name: 'Conversations' }).click();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();

  await expect(page).not.toHaveURL(first);
  await page.goBack();
  await expect(page).toHaveURL(first);
});

test('an unknown conversation says so rather than redirecting', async ({ page }) => {
  await page.goto('/c/does-not-exist');

  await expect(page.getByText(/isn’t on this device/)).toBeVisible();
  // The point of the panel: it must not have quietly sent them somewhere else.
  await expect(page).toHaveURL(/\/c\/does-not-exist$/);

  await page.getByRole('button', { name: 'Start a new conversation' }).click();
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/);
});

test('a shared session link adopts the session and pulls its transcript', async ({ page }) => {
  await page.goto(`/s/${SHARED_SID}`);

  await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/);
  await expect(page.getByText('BrettPhos, at 1.2 equiv base.')).toBeVisible();
});

test('a malformed share link is explained, not redirected', async ({ page }) => {
  await page.goto('/s/nonsense');
  await expect(page.getByText(/32-character session id/)).toBeVisible();
});

/** Below `lg` the sidebar is a drawer, so every sidebar control needs opening first. */
async function openSidebar(page: Page, isMobile: boolean | undefined): Promise<void> {
  if (isMobile) await page.getByRole('button', { name: 'Conversations' }).click();
}

test('the review queue is reachable and shows what would be committed', async ({
  page,
  isMobile,
}) => {
  // The largest capability the service had and the UI did not touch. Reaching it from the shell
  // is half the point — a queue nobody can navigate to is a queue nobody reviews.
  await page.goto('/');
  await openSidebar(page, isMobile);
  await page.getByRole('button', { name: 'Review queue' }).click();

  await expect(page).toHaveURL(/\/review$/);
  await page.getByRole('button', { name: /note-suzuki-42/ }).click();
  // The bytes, not a summary of them: a sign-off is on what lands in the tree.
  await expect(page.getByText(/confidence: 0\.8/)).toBeVisible();
});

test('the durable-run registry leads with why a run happened', async ({ page, isMobile }) => {
  await page.goto('/');
  await openSidebar(page, isMobile);
  await page.getByRole('button', { name: 'Durable runs' }).click();

  await expect(page).toHaveURL(/\/jobs$/);
  await expect(
    page.getByText('Decide whether 2-MeTHF or CPME favours the coupling.'),
  ).toBeVisible();
});
