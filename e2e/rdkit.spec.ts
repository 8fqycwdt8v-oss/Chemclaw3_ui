import { expect, test, type Page } from '@playwright/test';

/**
 * `ISSUES.md` Issue 10, closed: a structure is drawn behind the real BFF, under the policy it
 * really sends, and the document's policy still refuses `eval`.
 *
 * This suite's `webServer` is `node dist/server.js` — the production BFF, sending the production
 * CSP — so nothing here is a dev-server result. That is the whole point: Vite serves `index.html`
 * itself and sends no CSP, which is how "no container has ever drawn a structure" stayed invisible
 * while `npm run dev` drew every one.
 *
 * **What the fix is, measured before it was built.** A dedicated worker loaded from a network URL
 * runs under the CSP of its own response, not the document's; a `blob:` worker inherits the
 * document's. So the BFF sends `RDKIT_WORKER_CSP` (`server/config.ts`) on the RDKit worker's script
 * and on nothing else, and `'unsafe-eval'` — which RDKit's Embind glue needs for `Function(...)`
 * — exists only on a thread with no DOM. The two tests below are that sentence; the too-complex
 * wording, which this unblocked, is `e2e/rdkit-too-complex.spec.ts`.
 */

/** The structure images `Molecule` draws, once RDKit has answered with SVG markup. */
const drawn = (page: Page) => page.locator('[role="img"][aria-label^="Chemical structure"] svg');

/** Run a turn whose answer carries structures — the fixture's pKa answer screens `CCO`. */
async function askForStructures(page: Page): Promise<void> {
  await page.getByPlaceholder(/Ask about a reaction/).fill('What is the pKa of acetic acid?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Screened' })).toBeVisible({ timeout: 20_000 });
}

/**
 * Whether the *page* may evaluate a string, asked the only way a test can ask honestly.
 *
 * `page.evaluate` runs through the DevTools protocol, which evaluates with the CSP's eval check
 * lifted — `new Function` inside it succeeds under any policy, so asserting on it would pass with
 * `'unsafe-eval'` in the header. A string `setTimeout` is compiled later, by the page, under the
 * page's own policy: refused, it raises a `securitypolicyviolation` for `eval` and never runs.
 */
async function pageMayEval(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const scope = window as unknown as { __cspProbeRan?: boolean };
        scope.__cspProbeRan = false;
        document.addEventListener(
          'securitypolicyviolation',
          (event) => {
            if (event.blockedURI === 'eval') resolve(false);
          },
          { once: true },
        );
        // A string, deliberately: this is the form that is evaluated under the page's policy.
        (setTimeout as unknown as (code: string, ms: number) => void)(
          'window.__cspProbeRan = true',
          0,
        );
        setTimeout(() => resolve(scope.__cspProbeRan === true), 500);
      }),
  );
}

test('a structure is drawn behind the production BFF', async ({ page }) => {
  await page.goto('/');
  await askForStructures(page);

  // An `svg` inside the structure image is RDKit's own output: the fallback renders a `code` block
  // and a sentence instead, and never an `svg`.
  await expect(drawn(page).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/structure toolkit could not be loaded/)).toHaveCount(0);
});

test('the document refuses eval, and only the RDKit worker is allowed it', async ({ page }) => {
  const workerPolicies: string[] = [];
  page.on('response', (response) => {
    if (/\/assets\/rdkit\.worker-[A-Za-z0-9_-]{8,}\.js$/.test(response.url())) {
      workerPolicies.push(response.headers()['content-security-policy'] ?? '');
    }
  });

  const document = await page.goto('/');
  const documentPolicy = document?.headers()['content-security-policy'] ?? '';
  const scriptSrc = documentPolicy.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';

  // The header the document arrived with.
  expect(scriptSrc).toContain("'wasm-unsafe-eval'");
  expect(documentPolicy).not.toContain("'unsafe-eval'");
  // And the browser enforcing it, which is the claim that matters.
  expect(await pageMayEval(page)).toBe(false);

  await askForStructures(page);
  await expect(drawn(page).first()).toBeVisible({ timeout: 30_000 });

  // The worker's script is where the relaxation lives, and it arrived with it.
  expect(workerPolicies.length, 'the RDKit worker script was never fetched').toBeGreaterThan(0);
  for (const policy of workerPolicies) {
    expect(policy).toContain("'unsafe-eval'");
    expect(policy).toContain("default-src 'none'");
  }
  // Drawing a structure must not have widened the page: still refused after the worker ran.
  expect(await pageMayEval(page)).toBe(false);
});
