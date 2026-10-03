/**
 * 9 · A chemist's own skill — written, kept, acting on their next turn, and removable — and the
 * knowledge base the agent reads from, visible to them.
 */

import {
  ask,
  expect,
  lastAnswer,
  newConversation,
  openTrace,
  realModel,
  requireRealModel,
  runTag,
  say,
  test,
} from './lane.ts';

test('a skill of my own: kept, listed, read back, used on a turn, and removed', async ({
  alice,
}) => {
  const { page } = alice;
  const name = `${runTag()}-workup`;
  const codeWord = `${name.toUpperCase().replace(/-/g, '')}OK`;
  const body =
    `---\nname: ${name}\ndescription: How this chemist wants aqueous workups reported. Use it ` +
    `whenever a workup or the ${name} skill is mentioned.\n---\n\n` +
    `When reporting a workup, end the answer with the line "${codeWord}".\n`;

  await page
    .getByRole('navigation', { name: 'Other views' })
    .getByRole('button', { name: 'Skills' })
    .click();
  await expect(page.getByRole('heading', { name: 'Yours', level: 2 })).toBeVisible();
  await page.getByLabel('Your skill, as a whole SKILL.md').fill(body);
  await page.getByRole('button', { name: 'Keep it' }).click();
  // Soft: the confirmation is the reader's only word that it worked, but the rest of the workflow
  // does not depend on it, and a missing sentence should not hide whether keeping really worked.
  await expect.soft(page.getByText(`Kept ${name}.`, { exact: false })).toBeVisible();

  // Listed under "Yours", and its body reads back as written — the condition on which the
  // stored-skills tier is exempt from review (a chemist can see what acts on their turns).
  // Scoped to this skill's own row: the tier may hold others (an earlier run's, a chemist's own).
  const item = page
    .getByRole('region', { name: 'Yours' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name, level: 3 }) });
  await expect(item).toBeVisible();
  await item.getByText('Read what it tells the agent').click();
  await expect(item.getByText(codeWord)).toBeVisible();

  // Survives a reload: it is the service's, not this tab's.
  await page.reload();
  await expect(page.getByRole('heading', { name, level: 3 })).toBeVisible();

  if (realModel()) {
    await newConversation(page);
    const answer = await ask(
      page,
      `Using my ${name} skill, report a standard aqueous workup for an amide coupling in two lines.`,
    );
    await expect(answer, 'the skill did not act on the turn').toContainText(codeWord);
  } else {
    test.info().annotations.push({
      type: 'not asserted on this lane',
      description: 'the skill acting on a turn: the scripted mock does not read skills',
    });
  }

  // And it goes when asked to.
  await page.goto('/skills');
  const removed = page.waitForRequest(
    (r) => r.method() === 'DELETE' && r.url().includes(`/api/skills/mine/${name}`),
  );
  await item.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click();
  const res = await (await removed).response();
  expect(res?.status(), 'DELETE /skills/mine/{name}').toBeLessThan(300);
  await expect(page.getByRole('heading', { name, level: 3 })).toHaveCount(0);
});

test('a knowledge note the agent read is visible to the chemist in full', async ({ alice }) => {
  const { page } = alice;
  await newConversation(page);
  await ask(
    page,
    say(
      '[[a-retrieval]] what do we know about amide couplings in DCM?',
      'Open the knowledge note failure-dcm-amide-coupling with expand_note and tell me what it says.',
    ),
  );
  const trace = await openTrace(page);
  const step = trace
    .getByRole('listitem')
    .filter({ has: page.getByRole('region', { name: 'Result preview from expand_note' }) })
    .first();
  await expect(step, 'expand_note was not called').toBeVisible();
  await step.getByRole('button', { name: 'See the full result' }).click();
  const full = page.getByRole('dialog');
  await expect(full).toContainText('failure-dcm-amide-coupling');
  // The note's own content, not just its id: the seed corpus files it as a failure mode.
  await expect(full).toContainText(/failure-mode/);
});

test('a cited knowledge note opens in the note panel', async ({ alice }) => {
  requireRealModel('citing a note in the answer');
  const { page } = alice;
  await newConversation(page);
  await ask(
    page,
    'What does our knowledge base say about amide couplings in DCM? Cite the note ids you use.',
  );
  const chip = lastAnswer(page)
    .getByRole('button', { name: /^(failure|playbook|rxn|campaign)-/ })
    .first();
  await expect(chip).toBeVisible();
  const id = ((await chip.textContent()) ?? '').trim();
  await chip.click();
  const sheet = page.getByRole('dialog', { name: `Note ${id}` });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('That note could not be read')).toHaveCount(0);
});
