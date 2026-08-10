import { expect, test } from '@playwright/test';

/**
 * The flows a unit test cannot reach: real layout, real focus, a real stream over the real BFF.
 */

test('the shell paints and the empty state explains itself', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Chemclaw', level: 1 })).toBeVisible();
  await expect(page.getByPlaceholder(/Ask about a reaction/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('the answer arrives incrementally, not all at once', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder(/Ask about a reaction/).fill('What is the pKa of acetic acid?');
  await page.getByRole('button', { name: 'Send' }).click();

  const answer = page.getByRole('article', { name: 'Assistant answer' }).last();

  // Sample while the turn is still running. A chain that buffers would show nothing until the very
  // end and then jump straight to the full text — correct, and completely wrong.
  const lengths: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    lengths.push(((await answer.textContent()) ?? '').length);
    await page.waitForTimeout(180);
  }

  const grew = lengths.some((len, i) => i > 0 && len > (lengths[i - 1] ?? 0));
  expect(grew, `answer text never grew mid-stream: ${lengths.join(' → ')}`).toBe(true);

  await expect(answer).toContainText('4.76', { timeout: 15_000 });
});

test('stop ends the turn and unlocks the composer', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder(/Ask about a reaction/).fill('What is the pKa of acetic acid?');
  await page.getByRole('button', { name: 'Send' }).click();

  await page.getByRole('button', { name: 'Stop' }).click();

  await expect(page.getByText('Stopped before the answer was complete.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
});

test('the trace panel reports its own expanded state', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder(/Ask about a reaction/).fill('What is the pKa of acetic acid?');
  await page.getByRole('button', { name: 'Send' }).click();

  const toggle = page.getByRole('button', { name: /Show the agent’s work/ });
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Screen hazards')).toBeVisible();
  // What the call RETURNED, not just that it was made. The fixture used to send this under the
  // wrong field name, so the frame arrived with an empty preview and nothing here noticed.
  await expect(page.getByText('No acute hazards.')).toBeVisible();
});
