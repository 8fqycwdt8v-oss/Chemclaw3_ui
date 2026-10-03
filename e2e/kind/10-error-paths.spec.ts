/**
 * 10 · When something breaks, the chemist is told what broke — in words that point at the next
 * step — and never a bare "internal error" for a failure the system knows the kind of.
 *
 * Driven by the scripted mock's adversarial behaviours (core `cli/storm_behaviours.py`), because
 * these are exactly the inputs a real model cannot be prompted into: a model gateway that answers
 * 500, a call to a tool that does not exist, malformed arguments, a thread over the window.
 */

import { type Page } from '@playwright/test';
import {
  ask,
  banner,
  expect,
  lastAnswer,
  newConversation,
  openTrace,
  realModel,
  sendButton,
  test,
} from './lane.ts';

test.beforeEach(() => {
  test.skip(realModel(), 'these are scripted-mock fault injections; a real model has no markers');
});

/** The failure is said in the answer and in the banner, with a reference to quote — not hidden. */
async function honestFailure(page: Page, says: RegExp): Promise<void> {
  await expect(lastAnswer(page)).toContainText(says);
  await expect(banner(page)).toContainText(says);
  await expect(banner(page)).toContainText(/reference [0-9a-f]{32}/);
  await expect(lastAnswer(page)).not.toContainText(/internal error/i);
  await expect(banner(page)).not.toContainText(/internal error/i);
  // And the chemist can carry on: the composer is theirs again.
  await expect(sendButton(page)).toBeVisible();
}

test('the model gateway failing is reported as the model provider, not an internal error', async ({
  alice,
}) => {
  const { page } = alice;
  await newConversation(page);
  // HTTP 500 on every attempt: the SDK retries, then the turn fails at the provider.
  await ask(page, '[[f-http-500]] what is the pKa of acetic acid?');
  await honestFailure(page, /model|provider/i);
});

test('a call to a tool that does not exist is shown as that, and the turn says it failed', async ({
  alice,
}) => {
  const { page } = alice;
  await newConversation(page);
  await ask(page, '[[f-unknown-tool]] run the impossible tool');
  await honestFailure(page, /tool call\(s\) attempted, 1 failed/);
  const trace = await openTrace(page);
  // The row's label, identifier and status are sibling elements with no whitespace between them in
  // the DOM, so the claim is made over the laid-out text (`e2e/trace.ts` says why).
  const text = await trace.innerText();
  expect(text).toMatch(/tool_that_does_not_exist\s+failed/);
  expect(text).toMatch(/is not a valid tool/);
});

test('malformed tool arguments are refused at the tool boundary and said so', async ({ alice }) => {
  const { page } = alice;
  await newConversation(page);
  await ask(page, '[[f-malformed-json]] find notes with broken arguments');
  await expect(lastAnswer(page)).not.toContainText(/internal error/i);
  await expect(lastAnswer(page)).toContainText(/fail|could not|invalid|malformed/i);
  await expect(sendButton(page)).toBeVisible();
});

test('a thread over the model window says to start a fresh session, and offers it', async ({
  alice,
}) => {
  const { page } = alice;
  await newConversation(page);
  await ask(page, '[[h-oversize]] this request is over the endpoint limit');
  await honestFailure(page, /too long for the model/);
  await expect(banner(page).getByRole('button', { name: 'Start a fresh session' })).toBeVisible();
});

test('a tool given impossible chemistry fails as bad input, with the tool named', async ({
  alice,
}) => {
  const { page } = alice;
  await newConversation(page);
  await ask(page, '[[h-impossible-args]] reaction energy of an impossible reaction');
  await expect(lastAnswer(page)).not.toContainText(/internal error/i);
  const trace = await openTrace(page);
  await expect(trace.getByText('compute_reaction_energy').first()).toBeVisible();
  await expect(trace.getByText(/failed|refused|invalid|cannot|not/i).first()).toBeVisible();
});
