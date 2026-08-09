/**
 * The streaming path, in a real browser, through the real BFF, against the built bundle.
 *
 * These cover what unit tests structurally cannot. `tests/streamTurn.test.ts` stubs `fetch`, so it
 * proves the parser handles a chunked stream — but it cannot prove that the bundle boots, that the
 * runtime config script loads, or that the proxy delivers frames incrementally rather than in one
 * clump at the end. Every one of those is a production-path property, and each has its own history
 * of going wrong quietly.
 */

import { expect, test } from '@playwright/test';

const composer = 'textarea[aria-label="Message"]';

async function send(page: import('@playwright/test').Page, text: string): Promise<void> {
  await page.fill(composer, text);
  await page.press(composer, 'Enter');
}

test('boots, loads its runtime config, and reaches the service', async ({ page }) => {
  await page.goto('/');
  // If /config.js had not executed, `env.ts` would fail closed and the config screen would be
  // showing instead — which is the behaviour, but it is not this page.
  await expect(page.getByText('Configuration error')).toHaveCount(0);
  await expect(page.locator(composer)).toBeVisible();
  await expect(page.getByText('connected')).toBeVisible();
});

test('streams an answer incrementally rather than in one block', async ({ page }) => {
  await page.goto('/');
  await send(page, 'What is the pKa of acetic acid?');

  // Catch it mid-flight: the first words must be on screen before the last one is.
  await expect(page.getByText(/Acetic/)).toBeVisible();
  const partial = await page.locator('main, body').innerText();

  await expect(page.getByText('Acetic acid has a pKa of 4.76.')).toBeVisible();
  const complete = await page.locator('main, body').innerText();

  // If anything in the chain buffered the stream, the two snapshots would be identical.
  expect(complete.length).toBeGreaterThan(partial.length);
});

test('keeps the answer when a non-terminal error precedes it', async ({ page }) => {
  await page.goto('/');
  await send(page, 'SCENARIO:loop_cap');

  // Both, not either. This turn used to render only the error, discarding a complete answer the
  // backend had already sent.
  await expect(page.getByText('The pKa of acetic acid is 4.76.')).toBeVisible();
  await expect(page.getByText(/partial/i)).toBeVisible();
  // The correlation id is the only thing that makes the turn findable in the audit trail.
  await expect(page.getByText(/e2ecorrelation/)).toBeVisible();
});

test('says an answer was assembled with fewer tools, and scored by the weaker check', async ({
  page,
}) => {
  await page.goto('/');
  await send(page, 'SCENARIO:degraded');

  await expect(page.getByText('The batch record is silent on that.')).toBeVisible();
  // The pill names what was down, so "the ELN says nothing" and "the ELN was unreachable" are
  // distinguishable — which is the entire reason the event exists.
  await expect(page.getByText(/were unreachable for this turn/i)).toBeVisible();
  await expect(page.getByText(/eln/i)).toBeVisible();
  // `verified_by: 'citation-gate'` means the judge did not run — materially different from a low
  // score, and the badge must not imply the latter.
  await expect(page.getByText(/did not run/i)).toBeVisible();
});

test('shows what a tool returned, including the untruncated ids and figures', async ({ page }) => {
  await page.goto('/');
  await send(page, 'SCENARIO:tool');

  await expect(page.getByText('It is 4.76.')).toBeVisible();
  await page.getByRole('button', { name: /show the agent/i }).click();
  await expect(page.getByText('pKa 4.76 (predicted)')).toBeVisible();
  await expect(page.getByText(/note-17/)).toBeVisible();
});

test('the composer is reachable and operable by keyboard alone', async ({ page }) => {
  await page.goto('/');
  await page.locator(composer).focus();
  await expect(page.locator(composer)).toBeFocused();
  await page.keyboard.type('Hello');
  await page.keyboard.press('Enter');
  // Scoped to the transcript: the same text also becomes the conversation's title in the sidebar,
  // so an unscoped match is ambiguous.
  await expect(page.getByRole('log', { name: 'Conversation' }).getByText('Hello')).toBeVisible();
});

test('the durable-run and proposal surfaces load', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Runs' }).click();
  await expect(page.getByRole('heading', { name: 'Durable runs' })).toBeVisible();

  await page.getByRole('button', { name: 'Proposed notes' }).click();
  await expect(page.getByRole('heading', { name: 'Proposed notes' })).toBeVisible();
});

test('the conversation panel can be closed again on a narrow screen', async ({ page }) => {
  // The panel is `absolute` and covers the ☰ toggle that opened it, so without its own dismissal
  // path a phone user who opened it was stuck behind it for the rest of the session — on the
  // platform whose poisoned-state problem is the reason "Reset app" lives in there.
  await page.setViewportSize({ width: 375, height: 720 });
  await page.goto('/');

  const sidebar = page.locator('#conversation-sidebar');
  await expect(sidebar).toBeHidden();

  await page.getByRole('button', { name: 'Conversations' }).click();
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Reset app' })).toBeVisible();

  // Escape is one of the three ways out; the others are the backdrop and the ✕.
  await page.keyboard.press('Escape');
  await expect(sidebar).toBeHidden();
});

test('an over-cap upload gets a 413, not a reset connection', async ({ page }) => {
  // This is the one assertion a Node client cannot make. The first version of the body cap called
  // `req.destroy()` in the same tick as `res.end()`, and a Node client happened to surface the 413
  // anyway — while a browser, still mid-upload, discarded the response and reported
  // ERR_CONNECTION_RESET. `client.ts` then rendered "could not reach the service" for a file that
  // was simply too large, which is the opposite diagnosis. Only a real browser distinguishes them.
  await page.goto('/');
  const result = await page.evaluate(async () => {
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Over the 4 MB cap by a clear margin.
        body: JSON.stringify({ padding: 'x'.repeat(5_000_000) }),
      });
      return { status: res.status, detail: await res.text() };
    } catch (err) {
      return { status: 0, detail: err instanceof Error ? err.message : String(err) };
    }
  });
  expect(result.status).toBe(413);
  expect(result.detail).toMatch(/limit/);
});

test('the composer stays visible and usable at a phone width', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 720 });
  await page.goto('/');
  await expect(page.locator(composer)).toBeVisible();
  await send(page, 'hello from a phone');
  await expect(page.getByText('Acetic acid has a pKa of 4.76.')).toBeVisible();
});
