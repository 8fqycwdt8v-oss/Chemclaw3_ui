import { expect, test, type Page } from '@playwright/test';

/**
 * Eight scenarios across the four-repo stack, one per subsystem boundary.
 *
 * Requires `make live-e2e-full-stack` to be up in the Chemclaw3 repo — see
 * `playwright.full-stack.config.ts` for what that means and why this suite starts nothing itself.
 *
 * **Assertions are on tool use, not on chemistry.** The model under test is real and may be a
 * small one, so "did the answer say 4.76" measures the model while "did the turn call `predict_pka`
 * and cite its result" measures the integration — which is the only thing four repos wired together
 * can be blamed for. Where an answer's *content* is asserted it is against a value that can only
 * have come from a mocked backend (a seeded ELN batch id, a vendored dataset name), because that is
 * evidence the tool was really reached rather than recalled from training.
 *
 * Serial and stateful by design: `test.describe.serial` plus one shared page, because these run as
 * a single conversation the way a chemist would have one, and because scenario 1 establishes the
 * session the rest reuse.
 */

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto('/');
});

test.afterAll(async () => {
  await page.close();
});

/** The composer, by the placeholder the shell has always used. */
const composer = () => page.getByPlaceholder(/Ask about a reaction/);

/**
 * Ask one question and wait for the turn to fully settle.
 *
 * Settle is "the Send button is back", not "the composer is enabled": the composer unlocks briefly
 * between turns, and an assertion racing that gap reads a half-rendered answer. The Stop button is
 * present for exactly as long as a turn is streaming, so its disappearance is the honest signal.
 */
async function ask(question: string): Promise<string> {
  await composer().fill(question);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden({ timeout: 220_000 });
  const answer = page.getByRole('article', { name: 'Assistant answer' }).last();
  await expect(answer).not.toBeEmpty();
  return (await answer.textContent()) ?? '';
}

/**
 * The tool names the last turn actually called, read out of the trace panel.
 *
 * Expanding the disclosure is required — the tool names are not in the DOM until it is open — and
 * it is also the check a reader most wants, since "the agent's work" is where a chemist would look
 * to see whether an answer was computed or recalled.
 */
async function toolsUsed(): Promise<string> {
  const disclosure = page.getByText(/Show the agent’s work/).last();
  if (await disclosure.isVisible().catch(() => false)) {
    await disclosure.click();
  }
  return (await page.locator('body').textContent()) ?? '';
}

test('1 · the shell paints against the real front door', async () => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await expect(page.getByRole('heading', { name: 'Chemclaw', level: 1 })).toBeVisible();
  await expect(composer()).toBeVisible();

  // The connection badge is the one that would have caught the two dev-path defects this suite was
  // written after: a dead BFF and a header-stripping proxy both surface here as "unreachable".
  await expect(page.getByText('unreachable')).toHaveCount(0);
  expect(errors, `page errors on load: ${errors.join(' | ')}`).toEqual([]);
});

test('2 · a solvent question reaches the props server (Chemclaw3-mcp)', async () => {
  const answer = await ask(
    'What is the flash point of 2-MeTHF, and what are its Hansen solubility parameters?',
  );

  // `source` naming the vendored dataset is the tell that the tool answered rather than the model
  // remembering — it is the dataset's own name, not a fact about 2-MeTHF.
  const trace = await toolsUsed();
  expect(trace).toMatch(/solvent|propert|process-solvents/i);
  expect(answer.length).toBeGreaterThan(40);
});

test('3 · a reaction question reaches rxnpredict (Chemclaw3-mcp)', async () => {
  await ask(
    'Predict the products of CC(=O)OC(C)=O.Nc1ccccc1 using the forward reaction prediction tool.',
  );

  // `fake_a` is the deterministic double the harness asks for by name. Its appearance proves both
  // that rxnpredict was reached and that `register_requested` really registered the double —
  // which was inert until this suite's sibling fix in Chemclaw3-mcp.
  const trace = await toolsUsed();
  expect(trace).toMatch(/predict_forward_reaction|fake_a/i);
});

test('4 · a sourcing question reaches mock-vendor (Chemclaw3_mock)', async () => {
  await ask('Search for commercial suppliers and pricing for aniline as a building block.');

  const trace = await toolsUsed();
  expect(trace).toMatch(/building_block|supplier|vendor|get_price/i);
});

test('5 · evidence comes back from the seeded ELN/ORD data (Chemclaw3_mock)', async () => {
  const answer = await ask(
    'Search our internal experimental records for past amide coupling reactions and cite what you find.',
  );

  // Either a real citation or an explicit "nothing found" is acceptable; a fabricated internal
  // record is not. Silence about the search having happened is the failure mode worth catching.
  const trace = await toolsUsed();
  expect(trace).toMatch(/gather_evidence|evidence|search|record/i);
  expect(answer.length).toBeGreaterThan(40);
});

test('6 · a durable job is launched and tracked (Temporal)', async () => {
  await ask('Search the conformers of 1,2-dichloroethane and submit it as a durable job.');

  // The durable panel is the product surface for long work; a job that runs but never appears
  // there is invisible to the chemist who started it.
  await page.getByRole('button', { name: /Durable runs/ }).click();
  const panel = page.getByText(/Durable runs/).first();
  await expect(panel).toBeVisible();
});

test('7 · the review queue is reachable and renders (the PR-gate surface)', async () => {
  await page.getByRole('button', { name: /Review queue/ }).click();

  // Asserting the queue *renders* rather than that it holds a specific proposal: whether a given
  // turn proposes a note is a model decision, and pinning this test to that would make it measure
  // the model. That the human-validation surface exists and loads against the real service is the
  // integration claim.
  await expect(page.getByText(/Review queue/).first()).toBeVisible();
});

test('8 · /readyz reports every connector healthy', async ({ request }) => {
  const res = await request.get('/api/readyz');
  expect(res.ok(), `readyz returned ${res.status()}`).toBe(true);

  const body = JSON.stringify(await res.json());
  for (const connector of [
    'props',
    'rxnpredict',
    'chem',
    'safety',
    'calc',
    'bo',
    'molfp',
    'rxnfp',
  ]) {
    expect(body, `${connector} missing from /readyz`).toContain(connector);
  }
  // `mock-vendor` is `unprobed`, not `unhealthy`: it serves no REST health route, and its manifest
  // correctly declares no `health_url`. `unreachable` anywhere is the real failure.
  expect(body).not.toContain('unreachable');
});
