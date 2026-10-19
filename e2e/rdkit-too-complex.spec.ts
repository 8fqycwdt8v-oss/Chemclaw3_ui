import { expect, test } from '@playwright/test';

/**
 * The "too complex to name here" sentence, through a real RDKit in a real browser behind the real
 * BFF — the _Known gaps_ row that could not be closed while no container could load the toolkit
 * (`RDKIT_WORKER_CSP` in `server/config.ts`). A file of its own because the stack flag below is a
 * launch option, and Playwright starts a separate browser for a file that sets one.
 */

/**
 * A smaller V8 stack, so the refusal is deterministic rather than a coin toss.
 *
 * The refusal is a property of the JavaScript stack at the instant of the call, not of the
 * string (Issue 11). At the default stack, 580- and 600-carbon chains asked three times each in
 * three fresh pages refused once in eighteen asks and named themselves the rest. Under
 * `--stack-size` of 150, 250 and 400 every ask at 600 refused, every ask at 450 and below named,
 * and `CCO` still drew. So this is the real RDKit in a real worker, made to meet the limit every
 * time instead of sometimes — and the reason the
 * sentence under test says a second check may differ is the same measurement.
 */
test.use({
  launchOptions: {
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {}),
    args: ['--js-flags=--stack-size=400'],
  },
});

test('a chain RDKit cannot name says a retry may differ, and offers none', async ({ page }) => {
  await page.goto('/');
  const box = page.getByLabel('Message');
  await box.focus();
  // A synthetic paste, because the composer checks what is pasted rather than what is typed and
  // a headless clipboard is not something every runner grants. The handler reads
  // `clipboardData.getData('text')`, which this carries.
  await box.evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, 'C'.repeat(600));

  const strip = page.getByRole('alert').filter({ hasText: 'ran out of stack naming it' });
  await expect(strip).toBeVisible({ timeout: 30_000 });
  await expect(strip).toContainText(
    'checking the same structure again may give a different answer.',
  );
  // Not the chemical verdict, and not the toolkit being absent — the two sentences this row
  // exists to keep apart from it.
  await expect(strip).not.toContainText('could not read this as a molecule');
  await expect(page.getByText(/structure toolkit could not be loaded/)).toHaveCount(0);
  // The owner's decision: the copy names the non-determinism, and nothing offers to re-ask.
  await expect(page.getByRole('button', { name: /try again|retry|check again/i })).toHaveCount(0);
});
