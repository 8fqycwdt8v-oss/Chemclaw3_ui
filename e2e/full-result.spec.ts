import { expect, test, type Page } from '@playwright/test';

/**
 * A tool result the assistant read only part of, opened in full through the real BFF.
 *
 * The fixture's turn carries a `read_document` result with `result_cut: true`, whose ref serves
 * ~75 kB of prose with markup in it; the shared-link transcript carries a cut call whose ref
 * retention has swept, so it 404s.
 */

const NOTICE = 'Result was shortened for the assistant — open full result';

async function openCutStep(page: Page): Promise<void> {
  await page.getByRole('button', { name: /The agent’s work/ }).click();
  await page.getByRole('button', { name: 'Expand all' }).click();
  await page.getByRole('button', { name: NOTICE }).click();
}

test('a cut result opens as plain, bounded text with its size', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder(/Ask about a reaction/).fill('Read the SDS for 2-MeTHF.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Assistant answer' }).last()).toContainText(
    '4.76',
    { timeout: 15_000 },
  );

  await openCutStep(page);

  const panel = page.getByRole('dialog', { name: /full text/ });
  const text = panel.getByRole('region', { name: 'Full text returned by read_document' });
  await expect(text).toContainText('Safety data sheet, section 10');
  // Untrusted output is text: the tags are on screen as characters and nothing ran.
  await expect(text).toContainText('<b>Not bold</b>');
  expect(await text.locator('b, script').count()).toBe(0);
  expect(await page.evaluate(() => (window as { __fixturePwned?: boolean }).__fixturePwned)).toBe(
    undefined,
  );
  // Over the drawing bound: the tail is not drawn, and the panel says how much is not.
  await expect(text).not.toContainText('END OF DOCUMENT');
  await expect(panel.getByText(/Showing the first/)).toBeVisible();
  await expect(panel.getByTestId('full-result-size')).toContainText('KB');
  await expect(panel.getByRole('button', { name: 'Copy full text' })).toBeVisible();

  // Download carries the whole of it, tail included.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    panel.getByRole('button', { name: 'Download full text' }).click(),
  ]);
  const path = await download.path();
  const { readFile } = await import('node:fs/promises');
  expect(await readFile(path, 'utf8')).toContain('END OF DOCUMENT');
});

test('a cut result retention has swept says so, rather than failing', async ({ page }) => {
  await page.goto(`/open/${'b'.repeat(32)}`);
  await expect(page.getByText('BrettPhos, at 1.2 equiv base.')).toBeVisible();

  await openCutStep(page);

  const panel = page.getByRole('dialog', { name: /full text/ });
  await expect(panel.getByRole('alert')).toContainText('This full result is no longer available.');
  await expect(panel.getByRole('alert')).toContainText('Retention may have removed it');
});
