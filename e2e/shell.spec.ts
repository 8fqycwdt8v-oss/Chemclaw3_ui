import { expect, test } from '@playwright/test';

/** Theme, keyboard and the mobile layout — none of which the unit suite can observe. */

test('the theme choice survives a reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', /light|dark/);

  await page.getByRole('button', { name: /^Theme:/ }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.reload();
  // The boot script runs before the stylesheet, so this is also the no-flash assertion.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('a skip link is the first thing a keyboard reaches', async ({ page }) => {
  await page.goto('/');
  // The tab order only means anything once the app has rendered its controls.
  await expect(page.getByPlaceholder(/Ask about a reaction/)).toBeVisible();

  // Chromium's first Tab moves focus off the document before entering the page, so "first" is
  // about the first element the tab order actually lands on, not the first keypress. Walk until
  // focus leaves <body> and assert on where it first stopped — the claim is that nothing in the
  // app comes before the skip link, so any other landing spot is a failure.
  let landed = 'body';
  for (let i = 0; i < 3 && landed === 'body'; i += 1) {
    await page.keyboard.press('Tab');
    landed = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return 'body';
      return `${el.tagName.toLowerCase()}:${(el.textContent ?? '').trim().slice(0, 40)}`;
    });
  }

  expect(landed).toBe('a:Skip to conversation');
});

test('the composer shows a focus ring', async ({ page }) => {
  await page.goto('/');
  const box = page.getByPlaceholder(/Ask about a reaction/);
  await box.focus();
  // The wrapper carries the ring, because the textarea has no border of its own.
  const shadow = await box.evaluate(
    (el) => getComputedStyle(el.parentElement as HTMLElement).boxShadow,
  );
  expect(shadow).not.toBe('none');
});

test.describe('mobile', () => {
  test.skip(({ isMobile }) => !isMobile, 'covers the drawer layout only');

  test('the conversation list is reachable, including Reset app', async ({ page }) => {
    await page.goto('/');
    // The sidebar column is gone at this width; everything must come through the drawer.
    // `exact` matters: a conversation row and its action menu both mention the same title.
    const newConversation = page.getByRole('button', { name: 'New conversation', exact: true });
    await expect(newConversation).toBeHidden();

    await page.getByRole('button', { name: 'Conversations' }).click();

    await expect(newConversation).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reset app' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(newConversation).toBeHidden();
  });

  test('Enter inserts a newline instead of sending', async ({ page }) => {
    await page.goto('/');
    const box = page.getByPlaceholder(/Ask about a reaction/);
    await box.fill('first line');
    await box.press('Enter');
    await box.type('second line');

    await expect(box).toHaveValue('first line\nsecond line');
  });

  test('the composer sits above the bottom of the viewport', async ({ page }) => {
    await page.goto('/');
    const box = await page.locator('#composer').boundingBox();
    const height = page.viewportSize()?.height ?? 0;
    expect(box).not.toBeNull();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(height + 1);
  });
});
