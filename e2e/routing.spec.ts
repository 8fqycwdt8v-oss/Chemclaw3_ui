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
  await page.goto(`/open/${SHARED_SID}`);

  await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/);
  await expect(page.getByText('BrettPhos, at 1.2 equiv base.')).toBeVisible();
});

test('a malformed share link is explained, not redirected', async ({ page }) => {
  await page.goto('/open/nonsense');
  await expect(page.getByText(/32-character session id/)).toBeVisible();
});

test('an old /s/ bookmark is explained, through the real SPA fallback', async ({ page }) => {
  // The path this app used to mint. It had no route, so it fell through `<Route path="*">` to `/`
  // and opened a brand-new empty conversation — no error, nothing adopted, which a reader reads as
  // "my conversation was lost". Driven here rather than only in jsdom because the other half of
  // the claim is the BFF's own SPA fallback: a `/s/…` request has to reach `index.html` at all
  // before the router can say anything about it.
  await page.goto(`/s/${SHARED_SID}`);

  await expect(page.getByText('That link has moved')).toBeVisible();
  await expect(page.getByText(/\/open\//)).toBeVisible();
  // The URL is where the reader put it. A redirect here is the defect coming back.
  await expect(page).toHaveURL(new RegExp(`/s/${SHARED_SID}$`));
});

/** Below `lg` the sidebar is a drawer, so every sidebar control needs opening first. */
async function openSidebar(page: Page, isMobile: boolean | undefined): Promise<void> {
  if (isMobile) await page.getByRole('button', { name: 'Conversations' }).click();
}

test('the review queue is reachable and shows what is waiting on a person', async ({
  page,
  isMobile,
}) => {
  // Reaching it from the shell is half the point — a queue nobody can navigate to is a queue
  // nobody works. This used to click through to a proposal and assert on the bytes it would
  // commit; that section went with the PR gate
  // (`D-2026-09-05-the-gate-follows-behaviour-not-knowledge` in Chemclaw3), so what it now
  // asserts is the section that is still there and still blocks work.
  await page.goto('/');
  await openSidebar(page, isMobile);
  await page.getByRole('button', { name: 'Review queue' }).click();

  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByRole('heading', { name: 'Plans waiting on you' })).toBeVisible();
  await expect(page.getByText('Which solvent for the Suzuki step?')).toBeVisible();

  // The other direction, and the only assertion in this repository that drives the whole check-in
  // path: the shell claims `GET /check-ins` once per page through the real BFF, writes it into the
  // persisted store, and this section renders what it claimed. A component test cannot see any of
  // the three — it renders the section over a store somebody set by hand.
  await expect(
    page.getByRole('heading', { name: 'Your work waiting on somebody else' }),
  ).toBeVisible();
  await expect(page.getByText('Measured yield for the 2-MeTHF arm')).toBeVisible();
  await expect(page.getByText('5 days left')).toBeVisible();
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
