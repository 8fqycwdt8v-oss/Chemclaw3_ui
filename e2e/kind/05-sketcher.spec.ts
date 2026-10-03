/**
 * 5 · The sketcher: open Ketcher, draw a structure, insert it, and ask about it.
 *
 * Drawn the way a chemist draws — the benzene template from Ketcher's bottom toolbar, dropped on
 * the canvas — not through Ketcher's JavaScript API, so this exercises the editor's WASM worker
 * (Indigo), its export to a molblock, RDKit's canonicalisation in the app's own worker, and the
 * composer insertion in the production bundle behind the real BFF and CSP.
 */

import {
  ask,
  composer,
  expect,
  lastAnswer,
  newConversation,
  openTrace,
  realModel,
  say,
  test,
} from './lane.ts';

test('a drawn structure is inserted into the message and sent with the question', async ({
  alice,
}) => {
  const { page, problems } = alice;
  await newConversation(page);
  await composer(page).fill(say('[[a-cheap]] What do we know about ', 'What do we know about '));

  await page.getByRole('button', { name: 'Insert a structure' }).click();
  await page.getByRole('button', { name: 'Draw', exact: true }).click();

  const editor = page.getByRole('dialog').filter({ has: page.getByText('Draw a structure') });
  const canvasGroup = editor.getByRole('group', { name: 'Structure editor' });
  await expect(editor.getByText('Loading the structure editor…')).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(editor.getByText('The structure editor could not be loaded.')).toHaveCount(0);

  // Benzene, from the template strip, onto the middle of the molecule canvas.
  await canvasGroup.getByTestId('template-0').click();
  const canvas = canvasGroup.getByTestId('ketcher-canvas').last();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  await editor.getByRole('button', { name: 'Use this structure' }).click();
  await expect(editor).toBeHidden();

  // Back in the structure panel, RDKit says what it read — the string that will be sent.
  await expect(page.getByText(/RDKit read this as/)).toBeVisible();
  await expect(page.getByText('c1ccccc1', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(composer(page)).toHaveValue(/c1ccccc1/);

  // And it is the question that goes out: the transcript shows the structure in the user's
  // message, and the turn completes against it.
  const answer = await ask(page, `${await composer(page).inputValue()}?`);
  await expect(
    page
      .locator('#transcript')
      .getByText(/c1ccccc1/)
      .first(),
  ).toBeVisible();
  await expect(answer).not.toBeEmpty();
  if (realModel()) {
    // A model asked about a structure looks it up by structure; the trace says so.
    const trace = await openTrace(page);
    await expect(trace).toContainText(/c1ccccc1|benzene/i);
  }
  await expect(lastAnswer(page)).not.toContainText(/internal error/i);
  expect(
    problems.filter((p) => /Content Security Policy|wasm/i.test(p)),
    problems.join(' | '),
  ).toEqual([]);
});
