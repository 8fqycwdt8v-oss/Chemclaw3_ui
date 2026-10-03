/**
 * 8 · A turn survives the page going away under it, and Stop really stops one.
 */

import {
  answers,
  expect,
  lastAnswer,
  newConversation,
  say,
  send,
  sendButton,
  sessionIdOf,
  stopButton,
  test,
} from './lane.ts';

const SLOW = (what: string): string =>
  say(
    `[[f-slow]] ${what}`,
    `${what}: search our notes thoroughly for Buchwald–Hartwig amination failure modes and ` +
      'summarise every one you find, citing each.',
  );

test('reloading mid-turn reattaches to the turn and shows its answer', async ({ alice }) => {
  // Known defect, tracked as Chemclaw3_ui#131 (D5): the unloading page stops the turn. Remove this
  // line when the grace-stop fix lands; the test then has to pass outright.
  test.fail(true, 'Chemclaw3_ui#131 (D5)');
  const { page } = alice;
  await newConversation(page);
  await send(page, SLOW('reload mid-turn'));
  await expect(stopButton(page)).toBeVisible();
  // Long enough for the service to have accepted the turn and started it.
  await page.waitForTimeout(2_500);
  const url = page.url();

  await page.reload();
  await expect(page).toHaveURL(url);

  // The conversation is still here, the question is still here, and the answer arrives — either
  // live, by reattaching, or from the transcript once the turn the service kept running ends. What
  // is not acceptable is the question with nothing under it, or a failure banner for a turn that
  // finished fine on the server.
  await expect(page.locator('#transcript').getByText('reload mid-turn').first()).toBeVisible();
  await expect(answers(page).last()).toBeVisible({ timeout: 60_000 });
  await expect(stopButton(page)).toBeHidden({ timeout: 240_000 });
  await expect(lastAnswer(page)).toContainText(say('A deliberately slow turn.', ''), {
    timeout: 120_000,
  });
  await expect(lastAnswer(page)).not.toContainText('Stopped before the answer was complete.');
  await expect(page.getByRole('banner').getByRole('alert')).toHaveCount(0);
});

test('Stop ends the turn on the server, and the composer is free again', async ({ alice }) => {
  const { page } = alice;
  await newConversation(page);
  await send(page, SLOW('stop me'));
  await expect(stopButton(page)).toBeVisible();
  await page.waitForTimeout(1_500);
  const sessionId = await sessionIdOf(page);

  const stopped = page.waitForResponse(
    (r) => r.url().includes(`/sessions/${sessionId}/turn/stop`) && r.request().method() === 'POST',
  );
  await stopButton(page).click();
  const response = await stopped;
  expect(response.status(), `turn/stop answered ${response.status()}`).toBeLessThan(300);

  await expect(lastAnswer(page).getByText('Stopped before the answer was complete.')).toBeVisible();
  await expect(sendButton(page)).toBeVisible();

  // The server's turn really ended: the next question is answered, not refused as "a turn is
  // already running" (the 409 a leaked turn lease produces).
  await send(page, say('[[a-cheap]] after stop', 'In one sentence, what is a Suzuki coupling?'));
  await expect(stopButton(page)).toBeHidden({ timeout: 240_000 });
  await expect(lastAnswer(page)).not.toContainText(/already running|in progress/i);
  await expect(page.getByRole('banner').getByRole('alert')).toHaveCount(0);
});
