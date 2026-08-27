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

  // Scoped to the message, not to the page. The same sentence is also written into the polite live
  // region, and an unscoped `getByText` matches both the instant they overlap — a strict-mode
  // violation that turns a passing property into an intermittent red. The property worth asserting
  // here is the durable one a chemist can still read a minute later: the message itself is marked
  // as stopped. The announcement is `tests/announce.test.ts`'s job.
  await expect(
    page
      .getByRole('article', { name: 'Assistant answer' })
      .getByText('Stopped before the answer was complete.'),
  ).toBeVisible();
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
});

test('the full result is reachable from the trace, as data rather than a preview', async ({
  page,
}) => {
  // The turn streams a 200-character preview and a content-addressed ref. This is the path that
  // turns the ref into the hazard table the chemist has to act on — the severity, the rule that
  // fired, and the citation behind it, none of which survive the truncation.
  await page.goto('/');
  await page.getByPlaceholder(/Ask about a reaction/).fill('Screen this azide before I order it.');
  await page.getByRole('button', { name: 'Send' }).click();

  await page.getByRole('button', { name: /Show the agent’s work/ }).click();
  await page.getByRole('button', { name: 'See the full result' }).click();

  const panel = page.getByRole('dialog', { name: /full result/ });
  await expect(panel.getByText('organic-azide')).toBeVisible();
  await expect(panel.getByText('Bretherick’s Handbook, 7th ed.')).toBeVisible();
  // The caveat that does not survive a paraphrase, and the one the panel exists to keep. Read off
  // the panel's own note rather than by text, so it still passes when the service stops saying it.
  await expect(panel.getByRole('note')).toContainText('not a clearance');
});

test('the agent profile is chosen before the session exists, and not after', async ({ page }) => {
  // The profile is fixed on the service when the session is minted, so the control has to
  // disappear once there is one — otherwise it is a control that silently does nothing.
  await page.goto('/');
  const picker = page.getByLabel('Agent profile');
  await expect(picker).toBeVisible();
  await picker.selectOption('property-lookup');

  await page.getByPlaceholder(/Ask about a reaction/).fill('What is the pKa of acetic acid?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('article', { name: 'Assistant answer' }).last()).toContainText(
    '4.76',
    { timeout: 15_000 },
  );

  await expect(picker).toBeHidden();
});
