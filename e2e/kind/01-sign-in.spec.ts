/**
 * 1 · Sign-in: each person reaches a working conversation as themselves, and signing out ends it.
 *
 * `e2e/oidc-mock.spec.ts` proves the same hops against a fixture service; here the far side is the
 * real front door, validating the mock tenant's tokens with Chemclaw3's own four checks.
 */

import {
  ALICE,
  BOB,
  DEV_NAME,
  accountButton,
  ask,
  authModeOf,
  bearerOf,
  claimsOf,
  composer,
  expect,
  lane,
  newConversation,
  requireTwoPeople,
  runTag,
  say,
  signIn,
  test,
} from './lane.ts';

test('sign-in lands on a conversation you can type into, not on a missing one', async ({
  browser,
}) => {
  // The landing is asserted *before* anything else touches the page. After the tenant hands the
  // code back, `/auth/callback` sends the SPA to `/`, which picks (or creates) a conversation —
  // and a chemist's first sight of the product is whatever that resolves to.
  const { page, context, problems } = await signIn(browser, ALICE);
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/);
  await expect(
    page.getByRole('heading', { name: 'That conversation isn’t on this device' }),
    'sign-in landed on the not-found panel instead of a conversation',
  ).toHaveCount(0);
  await expect(composer(page)).toBeVisible();
  await expect(page.getByText('unreachable')).toHaveCount(0);
  expect(
    problems.filter((p) => p.startsWith('pageerror')),
    problems.join(' | '),
  ).toEqual([]);
  await context.close();
});

test('alice and bob each see and send their own identity, and the service accepts both', async ({
  browser,
  authMode,
}) => {
  if (authMode === 'dev') {
    // One principal: the claim reduces to "the shell knows who it is".
    const { page, context } = await signIn(browser, ALICE);
    await expect(accountButton(page)).toHaveText(DEV_NAME);
    await context.close();
  }
  requireTwoPeople(authMode);

  const alice = await signIn(browser, ALICE);
  const bob = await signIn(browser, BOB);

  for (const [session, other] of [
    [alice, BOB],
    [bob, ALICE],
  ] as const) {
    const { page, person } = session;
    await expect(accountButton(page)).toHaveText(person.name);
    await accountButton(page).click();
    await expect(page.getByRole('menu').getByText(person.upn)).toBeVisible();
    await expect(page.getByText(other.upn)).toHaveCount(0);
    await page.keyboard.press('Escape');

    const claims = claimsOf((await bearerOf(page))!);
    expect(claims).toMatchObject({ oid: person.oid, aud: 'api://chemclaw', scp: 'Chat.Access' });
  }

  // And the front door, not just the page, takes each of them as themselves: one turn each, and
  // each lands. A refused bearer is a 401 banner here, not a silent pass.
  for (const { page } of [alice, bob]) {
    // A fresh conversation rather than wherever sign-in landed: the landing is the first test's
    // claim, and this one is about the bearer.
    await newConversation(page);
    const answer = await ask(page, say('[[a-cheap]] sign-in check', 'Say hello in five words.'));
    await expect(answer).not.toBeEmpty();
    await expect(page.getByRole('banner').getByRole('alert')).toHaveCount(0);
  }

  await alice.context.close();
  await bob.context.close();
});

test('an anonymous caller is refused by the front door itself', async ({ authMode, request }) => {
  requireTwoPeople(authMode);
  // Not through the BFF: this is the service's own posture, which the SPA's redirect must never be
  // the only thing standing behind.
  const res = await request.post(`${lane().coreUrl}/sessions`, { data: {} });
  expect(res.status()).toBe(401);
});

test('signing out ends the session at the authority; the next person sees nothing of the last', async ({
  browser,
}) => {
  const mode = await authModeOf(lane().uiUrl);
  test.skip(mode !== 'msal', 'devauth has no sign-in to end');
  const { page, context } = await signIn(browser, ALICE);
  const tag = runTag();
  await newConversation(page);
  await ask(page, say(`[[a-cheap]] ${tag} private to alice`, `${tag}: say hello in five words.`));
  await expect(page.getByRole('complementary').getByText(tag).first()).toBeVisible();

  const visited: string[] = [];
  page.on('request', (r) => {
    if (r.isNavigationRequest()) visited.push(r.url());
  });
  await accountButton(page).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();

  // Out through the tenant's end-session endpoint and back, signed out — so the next sign-in
  // lands on the login page again rather than silently SSO-ing back into alice.
  const chooseBob = page.getByTestId('mock-login-bob');
  await expect(chooseBob).toBeVisible({ timeout: 30_000 });
  expect(visited.some((u) => u.startsWith(`${lane().authority}/oauth2/v2.0/logout`))).toBe(true);

  // The shared-workstation case, in the same browser profile: bob signs in next and nothing of
  // alice's — not her conversation, not its title — is on his screen.
  await chooseBob.click();
  await expect(accountButton(page)).toHaveText(BOB.name, { timeout: 30_000 });
  await expect(
    composer(page).or(page.getByRole('button', { name: 'Start a new conversation' })),
  ).toBeVisible();
  await expect(page.getByRole('complementary').getByText(tag)).toHaveCount(0);
  await context.close();
});
