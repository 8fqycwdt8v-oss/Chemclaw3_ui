import { expect, test, type Page } from '@playwright/test';
import { toolNames, traceText } from './trace.ts';

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
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden({ timeout: 220_000 });
  const answer = page.getByRole('article', { name: 'Assistant answer' }).last();
  await expect(answer).not.toBeEmpty();
  return (await answer.textContent()) ?? '';
}

/**
 * The tool identifiers the last turn actually called.
 *
 * This used to return `page.locator('body').textContent()` — the whole page, transcript included,
 * question included — and the scenarios below were regexes over that string. Two of them were
 * satisfied by the question the test had just typed: asked to "search for commercial *suppliers*",
 * `/supplier/` matched before any tool ran, so the scenario passed with `mock-vendor` down. The
 * read is now scoped to the trace region and returns identifiers rather than prose, because a
 * chemist's question is words and a tool call is a `snake_case` name. See `e2e/trace.ts`, and
 * `e2e/trace-scope.spec.ts` for the fixture-tier test that proves the scoping holds.
 */
const toolsUsed = (): Promise<string[]> => toolNames(page);

/** The same trace as one string, for the few claims that are about a row rather than a name. */
const traceOf = (): Promise<string> => traceText(page);

/** Assertion message that names what the turn actually did, so a red run is diagnosable. */
const used = (names: string[]): string =>
  `tools called by this turn: ${names.join(', ') || 'none'}`;

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

  // A tool name, not a topic word. `/solvent/` would also match the answer's prose and, before the
  // read was scoped, the question itself.
  const names = await toolsUsed();
  expect(names, used(names)).not.toEqual([]);
  expect(names.join(' '), used(names)).toMatch(/solvent|hansen|flash|propert/i);
  expect(answer.length).toBeGreaterThan(40);
});

test('3 · a reaction question reaches rxnpredict (Chemclaw3-mcp)', async () => {
  await ask(
    'Predict the products of CC(=O)OC(C)=O.Nc1ccccc1 using the forward reaction prediction tool.',
  );

  // `fake_a` is the deterministic double the harness asks for by name. Its appearance proves both
  // that rxnpredict was reached and that `register_requested` really registered the double —
  // which was inert until this suite's sibling fix in Chemclaw3-mcp.
  const names = await toolsUsed();
  expect(names, used(names)).toContain('predict_forward_reaction');
});

test('4 · a sourcing question reaches mock-vendor (Chemclaw3_mock)', async () => {
  await ask('Search for commercial suppliers and pricing for aniline as a building block.');

  // The question contains "suppliers" and "building block". Both used to satisfy this assertion on
  // their own, because the read was of the whole page. Now the read is of the trace and the match
  // is on an identifier, which no question can contain.
  const names = await toolsUsed();
  expect(names, used(names)).not.toEqual([]);
  expect(names.join(' '), used(names)).toMatch(/building_block|supplier|vendor|price/);
});

test('5 · evidence comes back from the seeded ELN/ORD data (Chemclaw3_mock)', async () => {
  const answer = await ask(
    'Search our internal experimental records for past amide coupling reactions and cite what you find.',
  );

  // Either a real citation or an explicit "nothing found" is acceptable; a fabricated internal
  // record is not. Silence about the search having happened is the failure mode worth catching.
  //
  // The question says "Search our internal experimental *records*", so `/search|record/` over the
  // page body was satisfied by the question alone — this scenario could not fail with the ELN
  // connector unreachable. An identifier is what distinguishes "it searched" from "it was asked to".
  const names = await toolsUsed();
  expect(names, used(names)).not.toEqual([]);
  expect(names.join(' '), used(names)).toMatch(/gather_evidence|find_notes|search_|_search/);
  expect(answer.length).toBeGreaterThan(40);
});

test('6 · a durable job is launched and tracked (Temporal)', async () => {
  await ask('Search the conformers of 1,2-dichloroethane and submit it as a durable job.');

  // First: a job was really launched. `job_started` renders "Started <kind>" plus the job's own id
  // in the trace, and neither can come from the question — which is what the previous version of
  // this scenario could not say, since it asserted only that a sidebar button existed.
  const names = await toolsUsed();
  expect(names, used(names)).not.toEqual([]);
  expect(await traceOf(), `no durable job was started; ${used(names)}`).toMatch(/\bStarted\b/);

  // Then: the durable panel is the product surface for long work, and a job that runs but never
  // appears there is invisible to the chemist who started it. Asserted on the panel's own H2 —
  // the sidebar control is a button, so this cannot be satisfied by the thing just clicked, which
  // is exactly how the old assertion passed with the registry unreachable.
  await page.getByRole('button', { name: /Durable runs/ }).click();
  await expect(page.getByRole('heading', { name: 'Durable runs', level: 2 })).toBeVisible();
  // And it resolved against the real registry rather than sitting on its loading state.
  //
  // Deliberately not "a row for the job just launched": the registry holds *finished* runs, and a
  // conformer search launched seconds ago has not finished. The strong claim about Temporal is the
  // `Started` row above; this one is about the panel reaching the service at all. The panel's
  // empty state is reached both by an empty registry and by a failed fetch, so it is the loading
  // copy that carries the signal here.
  await expect(page.getByText('Reading the registry…')).toHaveCount(0);
});

test('7 · the review queue is reachable and renders (what is waiting on a human)', async () => {
  await page.getByRole('button', { name: /Review queue/ }).click();

  // Asserting the page *renders* rather than that it holds a specific row: whether a given turn
  // raises a plan or a question is a model decision, and pinning this test to that would make it
  // measure the model. That the surface exists and loads against the real service is the
  // integration claim.
  //
  // But it has to be an assertion about the *panel*. `getByText(/Review queue/).first()` resolved
  // to the sidebar button this test had just clicked — first in DOM order, visible before and
  // after the click — so the scenario passed with the service down. Both headings below belong to
  // the panel and to nothing else. (A third, 'Notes waiting for review', stood here until
  // Chemclaw3 deleted the PR gate and its `/proposals` routes.)
  await expect(page.getByRole('heading', { name: 'Plans waiting on you', level: 2 })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Questions waiting on you', level: 2 }),
  ).toBeVisible();

  // And the lists resolved rather than sitting on their loading copy, which is the difference
  // between "the surface loads" and "the surface is still asking".
  //
  // Note what this still cannot claim: these components fall back to an empty list on a failed
  // fetch, so the empty state and a healthy empty queue are indistinguishable from here. Closing
  // that needs the components to render the failure, which is a `src/components` change and a
  // product decision — recorded rather than papered over with an assertion that reads stronger
  // than it is.
  await expect(page.getByText('Reading the plan gate…')).toHaveCount(0);
  await expect(page.getByText('Reading what is waiting…')).toHaveCount(0);
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
