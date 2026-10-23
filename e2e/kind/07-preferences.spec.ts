/**
 * 7 · Preferences: a chemist says once that a solvent is off the table, and later answers keep to it.
 *
 * There is no preferences screen: a preference is stated in conversation and stored by the agent's
 * `remember_preference` tool, then injected into every later turn's system prompt by core's
 * `agent/preferences.py` middleware ("standing preferences"). So the whole workflow is a model
 * decision twice over — to store it, and to honour it.
 *
 * On the mock, `[[e2e:remember]]` stores `forbidden_solvent_dcm`, and `[[e2e:conditions]]` answers
 * by opening with the standing-preferences entries its system message carried ("Standing
 * preferences received: …", or "No standing preferences reached me.") and recommending the first
 * solvent none of them excludes — DCM when nothing arrived. So a green mock run proves the store,
 * the section and its delivery to the model; whether a model would choose to honour it is the live
 * lane's question.
 */

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

test('a forbidden solvent, stated once, is kept out of a later answer in a new conversation', async ({
  alice,
}) => {
  const { page } = alice;
  const tag = runTag();

  await newConversation(page);
  await ask(
    page,
    say(
      `[[e2e:remember]] ${tag} never use DCM`,
      `${tag}: Please remember this as a standing preference for all my future work: I never use ` +
        'dichloromethane (DCM) as a solvent — it is forbidden in my lab.',
    ),
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
    say(
      `[[e2e:conditions]] ${tag} EDC/HOBt amide coupling`,
      `${tag}: Suggest a solvent and conditions for an EDC/HOBt amide coupling of benzoic acid ` +
        'with benzylamine. Name exactly one solvent to use.',
    ),
  );
  if (!realModel()) {
    // The plumbing: the section reached the model, carrying the entry just stored …
    await expect(answer).toContainText('Standing preferences received:');
    await expect(answer, 'the stored DCM preference is not among those received').toContainText(
      /dichloromethane|DCM/,
    );
    // … and the respect: the solvent it recommends is not the one the preference excludes.
    const recommended = /Conditions:[^\n]*? in (.+?) at room temperature/.exec(
      await answer.innerText(),
    )?.[1];
    expect(recommended, 'the scripted answer names no solvent').toBeTruthy();
    expect(recommended).not.toMatch(/dichloromethane|DCM/i);
  }
  const text = (await answer.innerText()).toLowerCase();
  // Mentioning DCM to say it is avoided is fine; recommending it is not.
  const recommendsDcm =
    /\b(use|in|solvent:?)\s+(dry\s+|anhydrous\s+)?(dichloromethane|dcm|ch2cl2)\b/.test(text) &&
    !/(avoid|not|never|instead of|forbidden|excluded)[^.]{0,60}(dichloromethane|dcm)/.test(text);
  expect(recommendsDcm, `the answer recommends DCM:\n${text}`).toBe(false);
  await expect(lastAnswer(page)).not.toBeEmpty();
});
