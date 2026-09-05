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

/**
 * `exclude` is a deliberate hole in the scan, and there is exactly one.
 *
 * Excluding a region is how a scan stops meaning anything, so the only selector ever passed here
 * is `[data-sketcher-canvas]` — a third-party WASM structure editor whose markup this repository
 * does not write and cannot fix. Scanning it would produce violations no commit here can close,
 * and a permanently red gate is one everybody learns to skip. What the exclusion costs is written
 * down in `ISSUES.md` rather than absorbed, and what it does not excuse is asserted directly: the
 * dialog around the canvas still gets scanned, and the text alternative it offers is checked.
 */
async function scan(page: Page, exclude?: string): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(RULES);
  if (exclude) builder = builder.exclude(exclude);
  const { violations } = await builder.analyze();
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
      await page.getByRole('button', { name: 'Send', exact: true }).click();

      const answer = page.getByRole('article', { name: 'Assistant answer' }).last();
      await expect(answer).toContainText('4.76', { timeout: 15_000 });
      // The trace is a disclosure with tool rows and a plan inside — the densest markup here, and
      // the part most likely to grow an unlabelled control.
      await page.getByRole('button', { name: /The agent’s work/ }).click();
      await expect(page.getByText('screen_hazards').first()).toBeVisible();
      await scan(page);
    });

    test('the full result panel', async ({ page }) => {
      // Denser than anything else in the app: a modal panel holding a data table, which is where
      // an unlabelled column header or an unreachable scroll region would go unnoticed. The
      // scroll region is not hypothetical — a real tool result overflows it, and axe caught that
      // the block had no keyboard access the first time a realistic one was put through it.
      await page.goto('/');
      await page.getByPlaceholder(/Ask about a reaction/).fill('Screen this azide.');
      await page.getByRole('button', { name: 'Send', exact: true }).click();

      // Opened from the block in the answer, which is the path a chemist actually takes now —
      // the same sheet, reached without opening the trace and hunting for the row.
      await page.getByRole('button', { name: 'Open full result' }).first().click();
      await expect(page.getByRole('dialog', { name: /full result/ })).toBeVisible();
      await scan(page);
    });

    test('the review queue, with a plan waiting', async ({ page }) => {
      // A list of decisions somebody has to take, each linking back into the conversation that
      // raised it. Reached by URL rather than through the sidebar, because the drawer is already
      // covered below. This used to open a proposal sheet — a modal over the list with a labelled
      // textarea and two destructive controls — which went with the PR gate; the page's remaining
      // sections are plainer, and this pass is what says so rather than assuming it.
      await page.goto('/review');
      await expect(
        page.getByRole('heading', { name: 'Plans waiting on you', level: 2 }),
      ).toBeVisible();
      await expect(page.getByText('Which solvent for the Suzuki step?')).toBeVisible();
      await scan(page);
    });

    test('the protocol document, and the editor over it', async ({ page }) => {
      // The densest page in the app: five scrolling tables, a plate grid whose row and column
      // headers are the only thing locating a well, and then a modal form of two dozen numeric
      // inputs over the top of it. Every one of those inputs is labelled by its own species or arm
      // rather than by "Temperature" repeated eleven times, which is a property axe checks and a
      // reader would otherwise learn by tabbing.
      await page.goto('/protocols/design-0123456789ab');
      await expect(page.getByRole('region', { name: /Plate map/ })).toBeVisible();
      await scan(page);

      await page.getByRole('button', { name: /Edit this protocol/ }).click();
      await expect(page.getByLabel(/Change note/)).toBeVisible();
      await scan(page);
    });

    test('the conversation that is not on this device', async ({ page }) => {
      // A new page, a new focus target, and the one state reached by a link rather than a click.
      await page.goto('/c/does-not-exist');
      await expect(page.getByText(/isn’t on this device/)).toBeVisible();
      await scan(page);
    });

    test('the structure sketcher, and the alternative it names', async ({ page }) => {
      // The one state in this app with an inaccessible core: a pointer-driven canvas inside a
      // modal. The honest position — argued in `ISSUES.md` and stated in the dialog itself — is
      // that drawing is one of three doors and the other two are text, so what is asserted here is
      // that a screen-reader user is *told* that on open rather than meeting an unlabelled canvas.
      //
      // Ketcher is a multi-megabyte lazily-imported chunk, so this deliberately does not wait for
      // the editor: every assertion below is about the dialog chrome, which renders immediately
      // and is identical whether the editor loads, is still loading, or failed.
      await page.goto('/');
      await page.getByRole('button', { name: 'Insert a structure' }).click();

      // The alternative, before the modal: labelled, and reachable by keyboard like any input.
      await expect(page.getByLabel('SMILES')).toBeVisible();

      // `exact`, because the answer-rendering preference toggle is called "Draw structures in
      // answers" and a substring match resolves to both.
      await page.getByRole('button', { name: 'Draw', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      // Radix wires this to `aria-describedby`, so it is what a screen reader reads out with the
      // dialog's name. `tests/structureInput.test.tsx` pins the wiring; this pins that it survives
      // into a real browser with the real editor mounting underneath it.
      await expect(dialog).toContainText(/Cancel to paste SMILES or drop a MOL or SDF file/);

      await scan(page, '[data-sketcher-canvas]');
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
