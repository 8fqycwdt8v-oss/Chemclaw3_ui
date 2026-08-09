import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Automated accessibility checks on the states a chemist actually sits in.
 *
 * What this is and is not: axe catches the mechanical half — a control with no name, a landmark
 * nested wrong, a colour pair below ratio, an `aria-*` that points at nothing. It cannot tell you
 * whether the reading order makes sense or whether a live region says something useful, which is
 * why `scripts/check-contrast.mjs` and the announcer tests exist alongside it rather than being
 * replaced by it.
 *
 * Both themes, because the palette differs and half of what axe checks here is contrast.
 */

const RULES = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * Choose the theme before the page loads, rather than by driving the menu.
 *
 * Clicking the toggle leaves the pointer on its trigger, so its tooltip opens instantly and axe
 * measures the text mid-fade — a real 2.13:1 reading of a state that exists for 150ms. Setting
 * the stored choice is also what a returning reader's browser does, so it is the more
 * representative starting point anyway. `e2e/shell.spec.ts` covers the toggle itself.
 */
async function useTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    ['chemclaw3.theme', theme],
  );
}

async function expectTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function scan(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(RULES).analyze();
  // Name the rule and the node, or a red CI run tells you nothing about what to open.
  const detail = violations
    .map(
      (v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target).join('\n    ')}`,
    )
    .join('\n');
  expect(
    violations.map((v) => v.id),
    detail,
  ).toEqual([]);
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(theme, () => {
    test.beforeEach(async ({ page }) => {
      await useTheme(page, theme);
    });

    test('the empty conversation', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByPlaceholder(/Ask about a reaction/)).toBeVisible();
      await expectTheme(page, theme);
      await scan(page);
    });

    test('a finished turn, with its trace expanded', async ({ page }) => {
      await page.goto('/');
      await page.getByPlaceholder(/Ask about a reaction/).fill('What is the pKa of acetic acid?');
      await page.getByRole('button', { name: 'Send' }).click();

      const answer = page.getByRole('article', { name: 'Assistant answer' }).last();
      await expect(answer).toContainText('4.76', { timeout: 15_000 });
      // The trace is a disclosure with tool rows and a plan inside — the densest markup here, and
      // the part most likely to grow an unlabelled control.
      await page.getByRole('button', { name: /Show the agent’s work/ }).click();
      await expect(page.getByText('screen_hazards').first()).toBeVisible();
      await scan(page);
    });

    test('the conversation that is not on this device', async ({ page }) => {
      // A new page, a new focus target, and the one state reached by a link rather than a click.
      await page.goto('/c/does-not-exist');
      await expect(page.getByText(/isn’t on this device/)).toBeVisible();
      await scan(page);
    });

    test('the conversation drawer', async ({ page, isMobile }) => {
      test.skip(!isMobile, 'the drawer only exists below lg');
      await page.goto('/');
      await page.getByRole('button', { name: 'Conversations' }).click();
      await expect(page.getByRole('button', { name: 'Reset app' })).toBeVisible();
      await scan(page);
    });
  });
}
