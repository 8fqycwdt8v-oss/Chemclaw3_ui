import { expect, test } from '@playwright/test';

/**
 * Answering a durable hold from the inbox, through the real BFF.
 *
 * The unit tests stub `api.decideApproval` and prove the component's logic. What they cannot prove
 * is that the request survives the trip: `POST /api/approvals/{id}/decision` has to match the BFF's
 * route whitelist, keep its body, and come back 204. That whitelist is a regex table, and a hold id
 * is the one path parameter in it that is not a 32-hex session id.
 */

test('the header says how many holds are waiting', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Approvals — 1 waiting/ })).toBeVisible();
});

test('a decision reaches the service and the row says what was decided', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Approvals — 1 waiting/ }).click();
  await expect(page.getByText(/BrettPhos outperformed Xantphos/)).toBeVisible();

  const decision = page.waitForResponse(
    (res) => res.url().includes('/api/approvals/approval-int-7/decision') && res.status() === 204,
  );

  // Two clicks, and the second one is inside a confirmation. That is the contract, not a detail:
  // the decision is irreversible and attributable, and a single tap was one mis-aimed thumb away
  // from approving work nobody read.
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Approve' }).click();

  await decision;
  await expect(page.getByText(/You approved this request/)).toBeVisible();
});
