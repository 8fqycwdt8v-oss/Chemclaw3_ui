/**
 * 7 · Preferences: a chemist says once that a solvent is off the table, and later answers keep to it.
 *
 * There is no preferences screen: a preference is stated in conversation and stored by the agent's
 * `remember_preference` tool, then injected into every later turn's system prompt by core's
 * `agent/preferences.py` middleware ("standing preferences"). So the whole workflow is a model
 * decision twice over — to store it, and to honour it — and the scripted mock makes neither.
 */

import {
  ask,
  expect,
  lastAnswer,
  newConversation,
  openTrace,
  requireRealModel,
  runTag,
  test,
  toolsCalled,
} from './lane.ts';

test('a forbidden solvent, stated once, is kept out of a later answer in a new conversation', async ({
  alice,
}) => {
  requireRealModel(
    'storing and honouring a preference (no scripted behaviour calls remember_preference, there ' +
      'is no preferences UI, and the mock records no prompts to inspect)',
  );
  const { page } = alice;
  const tag = runTag();

  await newConversation(page);
  await ask(
    page,
    `${tag}: Please remember this as a standing preference for all my future work: I never use ` +
      'dichloromethane (DCM) as a solvent — it is forbidden in my lab.',
  );
  const stored = await toolsCalled(page);
  expect(stored, `tools: ${stored.join(', ')}`).toContain('remember_preference');
  const trace = await openTrace(page);
  await expect(
    trace.getByRole('region', { name: 'Arguments to remember_preference' }),
  ).toContainText(/dichloromethane|DCM/i);

  // A different conversation: nothing of the first is in its thread, so only the stored preference
  // can carry the constraint across.
  await newConversation(page);
  const answer = await ask(
    page,
    'Suggest a solvent and conditions for an EDC/HOBt amide coupling of benzoic acid with ' +
      'benzylamine. Name exactly one solvent to use.',
  );
  const text = (await answer.innerText()).toLowerCase();
  // Mentioning DCM to say it is avoided is fine; recommending it is not.
  const recommendsDcm =
    /\b(use|in|solvent:?)\s+(dry\s+|anhydrous\s+)?(dichloromethane|dcm|ch2cl2)\b/.test(text) &&
    !/(avoid|not|never|instead of|forbidden|excluded)[^.]{0,60}(dichloromethane|dcm)/.test(text);
  expect(recommendsDcm, `the answer recommends DCM:\n${text}`).toBe(false);
  await expect(lastAnswer(page)).not.toBeEmpty();
});
