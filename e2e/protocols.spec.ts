import { expect, test, type Page } from '@playwright/test';

/**
 * The protocol surface, end to end through the real BFF.
 *
 * Three things are only provable in a browser and each one shipped green in a unit suite once
 * before somebody looked: that the **route is reachable from the shell** (a screen nobody can
 * navigate to is a screen nobody uses), that the **document renders against a real proxied
 * response** rather than a stubbed one, and that an **edit round-trips** — the save reaches the
 * service through the whitelist and the value comes back on the next read. A component test can
 * assert the POST body; only this can assert the whitelist did not refuse it.
 *
 * The protocol result block is here too, for the same reason `chat.spec.ts` checks the hazard one:
 * the registry dispatches on shape, and a renderer that throws on a real payload is invisible to a
 * dispatch test that never renders it.
 */

const DESIGN = 'design-0123456789ab';

/** Below `lg` the sidebar is a drawer, so every sidebar control needs opening first. */
async function openSidebar(page: Page, isMobile: boolean | undefined): Promise<void> {
  if (isMobile) await page.getByRole('button', { name: 'Conversations' }).click();
}

test('the protocol list is reachable from the shell and opens a document', async ({
  page,
  isMobile,
}) => {
  await page.goto('/');
  await openSidebar(page, isMobile);
  await page.getByRole('button', { name: 'Experiment protocols' }).click();

  await expect(page).toHaveURL(/\/protocols$/);
  // The status and the blocker count, which are what a reader scans a list of designs for.
  await expect(page.getByText('Amination solvent screen')).toBeVisible();
  await expect(page.getByText('1 blocker').first()).toBeVisible();

  await page.getByRole('button', { name: /Amination solvent screen/ }).click();
  await expect(page).toHaveURL(new RegExp(`/protocols/${DESIGN}$`));

  // The blocker leads, above the document it is about.
  await expect(page.getByText('4 arms were laid out on a plate with 2 free wells.')).toBeVisible();
  // The basis chips: an inferred field must never read like a stated one.
  await expect(page.getByText('inferred — nobody stated this')).toBeVisible();
  await expect(page.getByText('not stated').first()).toBeVisible();
  // The plate, drawn as a plate, with the control marked by its own word rather than by a colour.
  // Scoped to the map: the run sheet above it names the same control in a cell, and an unscoped
  // match would pass on the table while the grid rendered nothing.
  const plate = page.getByRole('region', { name: /Plate map/ });
  await expect(plate).toBeVisible();
  await expect(plate.getByText('positive')).toBeVisible();
  await expect(plate.getByText('arm-1')).toBeVisible();
});

test('an edit becomes a new revision and comes back on the next read', async ({ page }) => {
  await page.goto(`/protocols/${DESIGN}`);
  await expect(page.getByText('Amination solvent screen')).toBeVisible();

  await page.getByRole('button', { name: /Edit this protocol/ }).click();
  await page.getByLabel(/^Temperature/).fill('100');
  // The write is attributable and needs its reason before it is offered at all — the same rule the
  // review queue's rejection reason is under.
  const save = page.getByRole('button', { name: 'Save a new revision' });
  await expect(save).toBeDisabled();
  await page.getByLabel(/Change note/).fill('Raised the temperature to 100 °C.');
  await save.click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Save revision' }).click();

  // The revision NUMBER is deliberately not asserted: the fixture's head is process-global and
  // both browser projects drive it, so pinning `3` would make this test depend on which worker got
  // there first. What matters is that a revision was written and that the edit survived the round
  // trip.
  await expect(page.getByText(/Saved as revision/)).toBeVisible();
  // Read back through the proxy: the value is on the document, not only in the request body.
  await expect(page.getByText('100 °C')).toBeVisible();
});

test('a comparison of two revisions is grouped by what it touches', async ({ page }) => {
  await page.goto(`/protocols/${DESIGN}`);
  await expect(page.getByText('Amination solvent screen')).toBeVisible();

  // Move off the head so the history holds a revision to compare against.
  await page.getByRole('button', { name: /Edit this protocol/ }).click();
  await page.getByLabel(/Change note/).fill('Raised the temperature.');
  await page.getByRole('button', { name: 'Save a new revision' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByText(/Saved as revision/)).toBeVisible();

  await page.getByRole('button', { name: 'Compare' }).first().click();
  await expect(page.getByRole('region', { name: 'base changes' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'arms changes' })).toBeVisible();
});

test('a protocol result renders as a protocol under the answer', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('textbox', { name: /Message/ }).fill('Design the amination screen');
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  const block = page.locator('[data-result-block="protocol"]');
  await expect(block).toBeVisible({ timeout: 15_000 });
  // The caveat a compact card may never drop, and the count the service trimmed before the card
  // ever saw it — two different subtractions, and a reader needs both.
  await expect(block.getByText(/checks are structural/)).toBeVisible();
  await expect(block.getByText(/2 more are in the design itself/)).toBeVisible();
  await expect(block.getByRole('link', { name: /Open the full protocol/ })).toHaveAttribute(
    'href',
    `/protocols/${DESIGN}`,
  );
});
