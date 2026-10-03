/**
 * 4 · A durable job: launched from a turn, tracked to its end, found again in the registry with its
 * whole result readable ("full results viewable"), and — for a second one — cancelled.
 */

import { type Page } from '@playwright/test';
import {
  ask,
  expect,
  lastAnswer,
  newConversation,
  openTrace,
  runTag,
  say,
  send,
  stopButton,
  test,
} from './lane.ts';

const JOB_ID = /\bcalc-compute_reaction_energy-[0-9a-f]{8,}\b/;

/** Every distinct line the in-flight turn showed, sampled until it settles. */
async function watchTurn(page: Page): Promise<string[]> {
  const seen = new Set<string>();
  const deadline = Date.now() + 240_000;
  while ((await stopButton(page).isVisible()) && Date.now() < deadline) {
    const text = (
      await lastAnswer(page)
        .innerText()
        .catch(() => '')
    ).replace(/\s+/g, ' ');
    if (text) seen.add(text);
    await page.waitForTimeout(250);
  }
  await expect(stopButton(page)).toBeHidden();
  return [...seen];
}

test('a calculation job runs to completion and its whole result is readable', async ({ alice }) => {
  const { page } = alice;
  await newConversation(page);
  await send(
    page,
    say(
      '[[d-collide]] reaction energy of the ammonia synthesis',
      'Compute the GFN2-xTB reaction energy of N2 + 3 H2 -> 2 NH3 at 298 K with ' +
        'compute_reaction_energy, and report dE with its uncertainty.',
    ),
  );
  const states = await watchTurn(page);
  test.info().annotations.push({ type: 'in-flight states', description: states.join(' ⟶ ') });

  // The turn's card: the call, and what it returned.
  const trace = await openTrace(page);
  const preview = trace
    .getByRole('region', { name: 'Result preview from compute_reaction_energy' })
    .first();
  await expect(preview).toContainText(/dE\s*-?\d/);
  // Read now: the trace leaves the DOM when the registry is opened.
  const previewText = await preview.innerText();

  // A run that finished while the turn waited is announced by its id in the job feed. One the
  // service rejoined instead — the same payload already computed, which is what D-011's
  // idempotency means and what the scripted mock's fixed payload produces after its first run —
  // finishes before any stream could announce it, so there the registry is where it is found.
  const feed = page.getByRole('status', { name: 'Finished background jobs' });
  const announced = (await feed.count()) > 0 ? JOB_ID.exec(await feed.innerText())?.[0] : undefined;
  test.info().annotations.push({
    type: 'job announced in the feed',
    description: announced ?? 'no — a rejoined (already computed) run',
  });

  // The registry has it, completed, with its result in full rather than a preview.
  await page
    .getByRole('navigation', { name: 'Other views' })
    .getByRole('button', { name: 'Durable runs' })
    .click();
  await expect(page.getByRole('heading', { name: 'Durable runs', level: 2 })).toBeVisible();
  await expect(page.getByText('Reading the registry…')).toHaveCount(0);
  // Without an announcement, the newest *finished* row for this tool is the run the turn rejoined:
  // it is the one whose summary the turn's own preview quoted. (`hasText` matches the row's
  // textContent, where the summary and the id abut with no space, so no leading `\b` here.)
  const summary = /dE\s*-?[\d.]+\s*±\s*[\d.]+\s*kcal\/mol/.exec(previewText)?.[0];
  const jobId =
    announced ??
    /calc-compute_reaction_energy-[0-9a-f]{8,}/.exec(
      await page
        .getByRole('button')
        .filter({ hasText: /calc-compute_reaction_energy-[0-9a-f]{8,}/ })
        .filter({ hasText: 'finished' })
        .filter({ hasText: summary ?? 'kcal/mol' })
        .first()
        .innerText(),
    )![0];
  const row = page.getByRole('button').filter({ hasText: jobId });
  await expect(row, `${jobId} is not in the registry`).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}$`));
  const sheet = page.getByRole('dialog', { name: `Job ${jobId}` });
  await expect(sheet.getByText('completed', { exact: true })).toBeVisible();
  const result = sheet.getByRole('region', { name: "The job's result" });
  await expect(result).toContainText('reactants');
  await expect(result).toContainText(/GFN2-xTB/);
  // Full, not the 200-character preview the trace keeps.
  expect((await result.innerText()).length).toBeGreaterThan(previewText.length);
});

test('a second, long job can be cancelled from the registry', async ({ alice }) => {
  // On the mock, `[[e2e:long-job]]` launches a BO campaign on the `measured` objective, which
  // suspends on a person after its seed batch — running until cancelled. Its seed is derived from
  // the message, and the run tag makes the message (so the job) this run's own: a payload already
  // launched would rejoin that run (D-011) rather than start one.
  const { page } = alice;
  const tag = runTag();
  await newConversation(page);
  await ask(
    page,
    say(
      `[[e2e:long-job]] ${tag} start a measured campaign`,
      `${tag}: Start a conformer search for C(CCCCCCCCO)CCCCCCCCO at the most thorough level as ` +
        'a durable job and do not wait for it: tell me its job id as soon as it is launched.',
    ),
  );
  const text = (await lastAnswer(page).innerText()) + (await (await openTrace(page)).innerText());
  const id = /\b(?:calc|qm|bo)-[A-Za-z0-9_-]{8,}\b/.exec(text)?.[0];
  expect(id, 'no job id in the answer or its trace').toBeTruthy();

  await page.goto(`/jobs/${id}`);
  const sheet = page.getByRole('dialog', { name: `Job ${id}` });
  await expect(sheet.getByText(/^(queued|running)$/)).toBeVisible();
  const cancel = sheet.getByRole('button', { name: 'Request cancellation' });
  await expect(
    cancel,
    'no cancel control for a privileged user — is the BFF given REVIEWER_ROLES?',
  ).toBeVisible();
  await cancel.click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Request cancellation' }).click();
  await expect(sheet.getByRole('status')).toContainText('Cancellation requested');
  await expect(sheet.getByText(/^(cancelled|canceled|terminated)$/)).toBeVisible({
    timeout: 120_000,
  });
});

test('the cancel control is offered to a privileged user', async ({ alice }) => {
  // A wiring claim, mock or not: alice holds `reviewer` and `chemist`, and the service runs with
  // CHEMCLAW_ENTRA_PRIVILEGED_ROLES naming one of them — so the SPA must be told which roles may
  // decide, or it offers nobody the control the service would accept.
  const { page } = alice;
  const config = await page.evaluate(
    () =>
      (window as unknown as { __CHEMCLAW_CONFIG__: { authMode: string; reviewerRoles: string[] } })
        .__CHEMCLAW_CONFIG__,
  );
  test.skip(config.authMode !== 'msal', 'devauth opens the gate for everyone');
  expect(
    config.reviewerRoles,
    'the BFF serves reviewerRoles: [] — REVIEWER_ROLES is unset, so "Request cancellation" is ' +
      'hidden from every signed-in person',
  ).not.toEqual([]);
});
