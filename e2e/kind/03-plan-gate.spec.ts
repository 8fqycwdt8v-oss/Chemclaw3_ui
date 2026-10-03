/**
 * 3 · The plan gate: under a plan-only profile, work that changes state waits for a human.
 *
 * The `computation` profile is the one the chart ships at `harness_autonomy: plan_only`
 * (core `data/profiles/computation.yaml`), whatever the deployment-wide autonomy is. The profile is
 * chosen in the composer before the session exists — the only moment the service takes it.
 */

import { type Page } from '@playwright/test';
import {
  ask,
  expect,
  lastAnswer,
  newConversation,
  openTrace,
  realModel,
  runTag,
  say,
  test,
  toolsCalled,
} from './lane.ts';

const PLAN_PROFILE = 'computation';

async function choosePlanProfile(page: Page): Promise<void> {
  const picker = page.getByLabel('Agent profile');
  await expect(
    picker,
    'no agent-profile picker: GET /profiles offered one profile or none',
  ).toBeVisible();
  await picker.selectOption(PLAN_PROFILE);
}

/**
 * The ask that should end in a plan card. On the mock, `[[e2e:plan]]` writes a one-step plan
 * declaring `compute_reaction_energy` on its marked turn, and calls it on any later turn — the
 * follow-up is unmarked and inherits the behaviour, so the gate (not the script) decides whether
 * that call runs. The run tag keeps each scenario's conversation its own.
 */
const PLAN_ASK = (tag: string): string =>
  say(
    `[[e2e:plan]] ${tag} compute the ammonia reaction energy`,
    `${tag}: Compute the GFN2-xTB reaction energy of N2 + 3 H2 -> 2 NH3 at 298 K with ` +
      'compute_reaction_energy. Propose the plan first and wait for my approval before running it.',
  );

/** The plan card's two decisions, scoped to the last answer so an older card cannot answer. */
const planCard = (page: Page) => ({
  approve: lastAnswer(page).getByRole('button', { name: 'Approve plan' }),
  decline: lastAnswer(page).getByRole('button', { name: 'Decline' }),
});

test('an unapproved state-changing call is refused, and the refusal says why', async ({
  alice,
}) => {
  // Mock-reachable half of the gate: `[[d-collide]]` calls compute_reaction_energy outright, with
  // no plan at all. Under plan_only the gate must refuse it and the card must say it was the gate
  // — "not approved" — rather than a broken tool or an internal error.
  test.skip(realModel(), 'a real model proposes first; the approve/decline tests cover that lane');
  const { page } = alice;
  await newConversation(page);
  await choosePlanProfile(page);
  await ask(page, '[[d-collide]] reaction energy of ammonia synthesis');

  const trace = await openTrace(page);
  await expect(trace.getByText('compute_reaction_energy').first()).toBeVisible();
  await expect(
    trace.getByText(/approv|plan/i).first(),
    'the refusal does not mention the plan gate',
  ).toBeVisible();
  // Nothing ran: no job was launched for the chemist to find later.
  await expect(page.getByRole('status', { name: 'Finished background jobs' })).toHaveCount(0);
  await expect(page.getByText(/internal error/i)).toHaveCount(0);
});

test('a proposed plan is shown, approved, and then executed', async ({ alice }) => {
  const { page } = alice;
  await newConversation(page);
  await choosePlanProfile(page);
  await ask(page, PLAN_ASK(runTag()));

  const { approve } = planCard(page);
  await expect(approve, 'no plan card with an Approve control').toBeEnabled();
  await approve.click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Approve plan' }).click();
  await expect(lastAnswer(page).getByText(/next request only/)).toBeVisible();

  // "Continue" sends the follow-up that the approval covers; the turn now runs the tool.
  await lastAnswer(page).getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeHidden({
    timeout: 240_000,
  });
  const names = await toolsCalled(page);
  expect(names, `tools: ${names.join(', ')}`).toContain('compute_reaction_energy');
  const trace = await openTrace(page);
  await expect(
    trace.getByRole('region', { name: 'Result preview from compute_reaction_energy' }).first(),
  ).not.toBeEmpty();
  if (!realModel()) {
    await expect(lastAnswer(page)).toContainText('I ran the approved step');
  }
});

test('a declined plan runs nothing', async ({ alice }) => {
  const { page } = alice;
  await newConversation(page);
  await choosePlanProfile(page);
  await ask(page, PLAN_ASK(runTag()));

  const { decline } = planCard(page);
  await expect(decline, 'no plan card with a Decline control').toBeEnabled();
  await decline.click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Decline' }).click();
  await expect(
    lastAnswer(page).getByText('You declined this plan. Nothing will run.'),
  ).toBeVisible();

  // Asking it to go ahead anyway is refused by the gate, not obeyed. On the mock the follow-up
  // inherits `[[e2e:plan]]`, which *does* try the call — so there the gate's refusal is asserted
  // outright; a real model may also decline on its own, which is just as correct.
  await ask(page, 'Go ahead and run it now.');
  const names = await toolsCalled(page).catch(() => [] as string[]);
  if (!realModel()) {
    expect(names, `tools: ${names.join(', ')}`).toContain('compute_reaction_energy');
    await expect(lastAnswer(page)).toContainText('The plan gate refused compute_reaction_energy');
  }
  if (names.includes('compute_reaction_energy')) {
    const trace = await openTrace(page);
    await expect(trace.getByText(/approv|plan/i).first()).toBeVisible();
  }
  await expect(page.getByRole('status', { name: 'Finished background jobs' })).toHaveCount(0);
});
