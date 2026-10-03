/**
 * 6 · A shared session, from both chairs: alice owns it and lets bob in; bob queues behind her
 * running turn, withdraws a message, follows her turn, and is offered only what a member may do.
 *
 * Two people in two browser contexts against one front door — the whole point of the oidc-mock
 * mode, so this scenario skips in devauth.
 */

import { type Page } from '@playwright/test';
import {
  ALICE,
  BOB,
  answers,
  ask,
  expect,
  lastAnswer,
  newConversation,
  realModel,
  requireRealModel,
  requireTwoPeople,
  runTag,
  say,
  send,
  stopButton,
  test,
  type Session,
} from './lane.ts';

/**
 * The prompts, per lane.
 *
 * **Against the mock, one marker per conversation, and it is the opener's.** The mock picks its
 * behaviour by scanning the *whole* request for `[[name]]` in catalogue order, and chat completions
 * resends the whole thread — so once a conversation holds `[[a-cheap]]`, every later turn in it is
 * `a-cheap`, whatever marker the new message carries (measured: an `[[f-slow]]` asked after an
 * `[[a-cheap]]` answered in 0.4 s as `a-cheap`). So the opener carries `[[f-slow]]` — 8 s of
 * thinking before the first frame, long enough to queue behind — and every later message is
 * unmarked and inherits it.
 */
const OPENER = (tag: string): string =>
  say(
    `[[f-slow]] ${tag} shared start`,
    `${tag} shared start: in one sentence, what is a Suzuki coupling?`,
  );
const SLOW = (tag: string, what: string): string =>
  say(
    `${tag} ${what}`,
    `${tag} ${what}: search our notes thoroughly for Buchwald–Hartwig amination failure modes and ` +
      'summarise every one you find, citing each.',
  );
const QUICK = (tag: string, what: string): string =>
  say(`${tag} ${what}`, `${tag} ${what}: in one sentence, what is a Suzuki coupling?`);

const withdrawButton = (page: Page) => page.getByRole('button', { name: 'Withdraw' });

/** Alice: a conversation of her own, one turn in, with bob added as a member. */
async function aliceShares(alice: Session, tag: string): Promise<void> {
  const { page } = alice;
  await newConversation(page);
  await ask(page, OPENER(tag));
  await page.getByRole('button', { name: 'People in this conversation' }).click();
  const panel = page.getByRole('dialog', { name: 'People in this conversation' });
  await panel.getByLabel('Add a person by their account id').fill(BOB.oid);
  await panel.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(panel.getByText(BOB.oid)).toBeVisible();
  await page.keyboard.press('Escape');
}

/** Bob: the conversation is under "Shared with me", and opens on alice's transcript. */
async function bobOpens(bob: Session, tag: string): Promise<void> {
  const { page } = bob;
  await page.reload();
  const shared = page.getByRole('list', { name: 'Shared with me' });
  await expect(shared, 'nothing is listed under "Shared with me" for bob').toBeVisible();
  await shared
    .getByRole('button', { name: new RegExp(tag) })
    .first()
    .click();
  await expect(page.locator('#transcript').getByText(`${tag} shared start`).first()).toBeVisible();
}

test.describe('a shared session', () => {
  test.beforeEach(({ authMode }) => requireTwoPeople(authMode));

  test('bob queues behind alice, sees his place, and then gets his answer', async ({
    alice,
    bob,
  }) => {
    const tag = runTag();
    await aliceShares(alice, tag);
    await bobOpens(bob, tag);

    // Alice's turn is running …
    await send(alice.page, SLOW(tag, 'alice running'));
    await expect(stopButton(alice.page)).toBeVisible();

    // … so bob's message waits in line rather than being refused, and he is told where he stands.
    await send(bob.page, QUICK(tag, 'bob queued'));
    await expect(
      withdrawButton(bob.page),
      'bob is not offered Withdraw while waiting',
    ).toBeVisible();
    await expect(lastAnswer(bob.page)).toContainText(/Next in line|Waiting in line/);

    // Alice's finishes, then bob's runs as his own turn and is answered.
    await expect(stopButton(alice.page)).toBeHidden({ timeout: 240_000 });
    await expect(withdrawButton(bob.page)).toBeHidden({ timeout: 240_000 });
    await expect(stopButton(bob.page)).toBeHidden({ timeout: 240_000 });
    await expect(lastAnswer(bob.page)).not.toContainText(/Next in line|Waiting in line/);
    await expect(lastAnswer(bob.page)).not.toBeEmpty();
    await expect(bob.page.getByRole('banner').getByRole('alert')).toHaveCount(0);

    // And alice, the owner, sees bob's question in her conversation, attributed to him.
    // Known to fail until Chemclaw3_ui#130 (D4): the owner's transcript is never re-read.
    test.info().annotations.push({ type: 'issue', description: 'Chemclaw3_ui#130 (D4)' });
    await alice.page.reload();
    await expect(alice.page.locator('#transcript').getByText(`${tag} bob queued`)).toBeVisible();
  });

  test('bob withdraws a waiting message, and it never runs', async ({ alice, bob }) => {
    const tag = runTag();
    await aliceShares(alice, tag);
    await bobOpens(bob, tag);

    await send(alice.page, SLOW(tag, 'alice running'));
    await expect(stopButton(alice.page)).toBeVisible();
    await send(bob.page, QUICK(tag, 'bob withdrawn'));
    await expect(withdrawButton(bob.page)).toBeVisible();
    await withdrawButton(bob.page).click();

    // Withdrawn, said as such — not "stopped before the answer was complete", which describes an
    // answer that does not exist — and his composer is his again.
    await expect(withdrawButton(bob.page)).toBeHidden();
    await expect(lastAnswer(bob.page)).not.toContainText('Stopped before the answer was complete.');
    await expect(bob.page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();

    // After alice's turn, the line is empty: the withdrawn message never reached the transcript.
    await expect(stopButton(alice.page)).toBeHidden({ timeout: 240_000 });
    await alice.page.waitForTimeout(3_000);
    await alice.page.reload();
    await expect(
      alice.page.locator('#transcript').getByText(`${tag} alice running`).first(),
    ).toBeVisible();
    await expect(alice.page.locator('#transcript').getByText(`${tag} bob withdrawn`)).toHaveCount(
      0,
    );
  });

  test('bob follows alice’s running turn live, without reloading', async ({ alice, bob }) => {
    // Known defect, tracked as Chemclaw3_ui#130 (D4): nobody follows another participant's
    // running turn. Remove this line when the fix lands; the test then has to pass outright.
    test.fail(true, 'Chemclaw3_ui#130 (D4)');
    const tag = runTag();
    await aliceShares(alice, tag);
    await bobOpens(bob, tag);
    const before = await answers(bob.page).count();

    await send(alice.page, SLOW(tag, 'alice watched'));
    await expect(stopButton(alice.page)).toBeVisible();

    // The service fans a running turn out to every participant (`GET /sessions/{id}/turn/stream`,
    // Chemclaw3 #499). Bob, sitting in the conversation, should see alice's question and then her
    // answer arrive — without pressing anything.
    await expect(
      bob.page.locator('#transcript').getByText(`${tag} alice watched`),
      'bob never saw alice’s running question',
    ).toBeVisible({ timeout: 60_000 });
    await expect(stopButton(alice.page)).toBeHidden({ timeout: 240_000 });
    await expect(answers(bob.page), 'alice’s answer never reached bob’s open view').toHaveCount(
      before + 1,
      { timeout: 60_000 },
    );
  });

  test('a member is offered only what a member may do', async ({ alice, bob }) => {
    const tag = runTag();
    await aliceShares(alice, tag);
    await bobOpens(bob, tag);
    const { page } = bob;

    // The sidebar's actions: leave, and neither branch nor delete.
    const shared = page.getByRole('list', { name: 'Shared with me' });
    await shared
      .getByRole('button', { name: /^Actions for / })
      .first()
      .click();
    await expect(page.getByRole('menuitem', { name: 'Leave conversation' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Branch/ })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: /Delete/ })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // The people panel: who is here, and no way to add anybody.
    await page.getByRole('button', { name: 'People in this shared conversation' }).click();
    const panel = page.getByRole('dialog', { name: 'People in this conversation' });
    await expect(panel.getByText(ALICE.oid).or(panel.getByText(ALICE.name)).first()).toBeVisible();
    await expect(panel.getByLabel(/Add a person/)).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /^Remove / })).toHaveCount(0);
  });

  test('bob’s plan in alice’s conversation is in his inbox, badged as hers', async ({
    alice,
    bob,
  }) => {
    requireRealModel('proposing a plan');
    const tag = runTag();
    const { page } = alice;
    await newConversation(page);
    await page.getByLabel('Agent profile').selectOption('computation');
    await ask(page, OPENER(tag));
    await page.getByRole('button', { name: 'People in this conversation' }).click();
    const panel = page.getByRole('dialog', { name: 'People in this conversation' });
    await panel.getByLabel('Add a person by their account id').fill(BOB.oid);
    await panel.getByRole('button', { name: 'Add', exact: true }).click();
    await page.keyboard.press('Escape');
    await bobOpens(bob, tag);

    await ask(
      bob.page,
      'Compute the GFN2-xTB reaction energy of N2 + 3 H2 -> 2 NH3. Propose the plan and wait ' +
        'for approval.',
    );
    await expect(lastAnswer(bob.page).getByRole('button', { name: 'Approve plan' })).toBeEnabled();

    await bob.page
      .getByRole('navigation', { name: 'Other views' })
      .getByRole('button', { name: /^Review queue\b/ })
      .click();
    const row = bob.page.getByRole('listitem').filter({ hasText: tag });
    await expect(row).toBeVisible();
    await expect(row.getByText(/^Shared by /)).toBeVisible();
    expect(realModel()).toBe(true);
  });
});
