import { expect, test } from '@playwright/test';

/**
 * The skills screen and the proposal queue, in a real browser against the real BFF.
 *
 * These are the surfaces `D-2026-09-05-the-gate-follows-behaviour-not-knowledge` makes the
 * *condition* of the stored skills tiers' exemption from review: a chemist can see what is acting
 * on their turns and remove it. The unit lane covers their logic; what only a browser can show is
 * that the page renders at all behind the proxy — a blank page here is a control that silently
 * stops existing. The fixture is stateless, so each check asserts on the request it sent rather
 * than on a list that changed.
 */

test('shows both tiers, reads a body, and removes one of your own', async ({ page }) => {
  await page.goto('/skills');
  await expect(page.getByRole('heading', { name: 'Yours', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'my-workup', level: 3 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'house-workup', level: 3 })).toBeVisible();

  await page.getByText('Read what it tells the agent').first().click();
  await expect(page.getByText('Quench cold, then filter.')).toBeVisible();

  const removed = page.waitForRequest(
    (request) =>
      request.method() === 'DELETE' && request.url().includes('/api/skills/mine/my-workup'),
  );
  await page.getByRole('button', { name: 'Remove' }).first().click();
  await page.getByRole('button', { name: 'Remove', exact: true }).last().click();
  await removed;
});

test('writes one yourself, and says in the service’s words why a name was refused', async ({
  page,
}) => {
  await page.goto('/skills');
  const draft = page.getByLabel('Your skill, as a whole SKILL.md');

  await draft.fill('---\nname: suzuki-coupling\ndescription: mine\n---\n\nMine.\n');
  await page.getByRole('button', { name: 'Keep it' }).click();
  await expect(
    page.getByText('a skill this deployment ships is already called suzuki-coupling'),
  ).toBeVisible();

  await draft.fill('---\nname: my-other-workup\ndescription: mine\n---\n\nMine.\n');
  await page.getByRole('button', { name: 'Keep it' }).click();
  await expect(page.getByText(/Kept my-other-workup\./)).toBeVisible();
});

test('a proposal refused at the row cap says so, and stays to be decided', async ({ page }) => {
  await page.goto('/review');
  await expect(page.getByRole('heading', { name: 'pd-removal', level: 3 })).toBeVisible();
  await page.getByRole('button', { name: 'Keep this skill' }).click();
  await expect(page.getByText(/the most this deployment allows/)).toBeVisible();
  await expect(page.getByText(/already been decided/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Keep this skill' })).toBeEnabled();
});
