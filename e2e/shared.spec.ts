import { expect, test, type Page } from '@playwright/test';

/**
 * Shared sessions (Chemclaw3 #483), from both sides.
 *
 * The browser is `dev-user` throughout, so the two views are two sessions in
 * `e2e/fixture-service.ts`: one somebody else owns that `dev-user` was let into, and one `dev-user`
 * owns. What is pinned is what a person can see and do in each — the service enforces the rules,
 * and the fixture answers the owner's acts with its 403, so a control this UI wrongly offered would
 * show up here as a refusal on screen rather than passing quietly.
 */

const OWNER_OID = 'owner-oid-5b1f';
const OWNED_SID = '8'.repeat(32);
const STORAGE_KEY = 'chemclaw3.chat.v2.dev-user';
const OWNED = 'e2e-owned-shared';

/** Open the conversation list where it is: the column on desktop, the drawer on a phone. */
async function conversations(page: Page, isMobile: boolean): Promise<void> {
  if (isMobile) await page.getByRole('button', { name: 'Conversations' }).click();
}

async function openSharedAsMember(page: Page, isMobile: boolean): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/);
  await conversations(page, isMobile);
  const shared = page.getByRole('list', { name: 'Shared with me' });
  await shared.getByRole('button', { name: /^Shared amination screen/ }).click();
  await expect(
    page.locator('#transcript').getByText('Which base for the amination?'),
  ).toBeVisible();
}

test.describe('as a member of somebody else’s conversation', () => {
  test('says whose each question was, and whose the plan is', async ({ page, isMobile }) => {
    await openSharedAsMember(page, isMobile);

    // The owner's question carries the owner's id; the reader's own carries "You".
    const transcript = page.locator('#transcript');
    await expect(transcript.getByText(OWNER_OID, { exact: true }).first()).toBeVisible();
    await expect(transcript.getByText('You', { exact: true }).first()).toBeVisible();

    // The plan is the owner's, so the card names its author and does not offer the decision.
    await expect(page.getByText(/Proposed in answer to/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve plan' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Decline' })).toBeDisabled();
    await expect(page.getByText(new RegExp(`Only ${OWNER_OID} can approve`))).toBeVisible();
  });

  test('offers Leave, and neither Branch nor Delete', async ({ page, isMobile }) => {
    await openSharedAsMember(page, isMobile);
    await conversations(page, isMobile);
    const shared = page.getByRole('list', { name: 'Shared with me' });
    await shared.getByRole('button', { name: /^Actions for / }).click();

    await expect(page.getByRole('menuitem', { name: 'Leave conversation' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Branch/ })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: /Delete/ })).toHaveCount(0);
  });

  test('sees who is here, cannot add anybody, and can leave', async ({ page, isMobile }) => {
    await openSharedAsMember(page, isMobile);
    await page.getByRole('button', { name: 'People in this shared conversation' }).click();

    const panel = page.getByRole('dialog', { name: 'People in this conversation' });
    await expect(panel.getByText(OWNER_OID)).toBeVisible();
    await expect(panel.getByText('colleague-oid-77a2')).toBeVisible();
    await expect(panel.getByLabel(/Add a person/)).toHaveCount(0);

    // After leaving, the service no longer lists the conversation as shared with this person. The
    // fixture's listing is shared by every test running at once, so this one run's answer is
    // swapped here instead of mutating it.
    await page.route('**/api/sessions/shared', (route) => route.fulfill({ json: [] }));
    await panel.getByRole('button', { name: 'Leave this conversation' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Leave' }).click();

    // Gone from this browser, and the reader is somewhere that exists.
    await expect(panel).toBeHidden();
    await conversations(page, isMobile);
    await expect(page.getByRole('list', { name: 'Shared with me' })).toHaveCount(0);
  });
});

test.describe('as the owner', () => {
  test.beforeEach(async ({ page }) => {
    // A conversation of the reader's own, bound to the fixture's owned session. Seeded rather than
    // listed by `GET /sessions`, which every other spec's sidebar would then carry.
    const state = {
      version: 3,
      state: {
        conversations: {
          [OWNED]: {
            id: OWNED,
            sessionId: OWNED_SID,
            title: 'My solvent screen',
            createdAt: 1700000000000,
            updatedAt: 1700000000000,
            messages: [{ id: 'u1', role: 'user', text: 'Rank the solvents.', at: 1700000000000 }],
            contextLost: false,
            sessionOrigin: 'local',
          },
        },
        order: [OWNED],
        activeId: OWNED,
        jobFeed: [],
        notifyOnJobComplete: false,
      },
    };
    await page.addInitScript(
      ([key, value]) => window.localStorage.setItem(key as string, value as string),
      [STORAGE_KEY, JSON.stringify(state)],
    );
  });

  test('adds somebody, hears a refusal in the service’s words, and removes them', async ({
    page,
  }, info) => {
    // One actor per project: both projects drive the same fixture roster at once.
    const colleague = `colleague-${info.project.name}-${Date.now()}`;
    await page.goto(`/c/${OWNED}`);
    await page.getByRole('button', { name: 'People in this conversation' }).click();
    const panel = page.getByRole('dialog', { name: 'People in this conversation' });

    const input = panel.getByLabel('Add a person by their account id');
    await input.fill(colleague);
    await panel.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(panel.getByText(colleague)).toBeVisible();

    // The owner naming themself is the service's 409, said in its own sentence.
    await input.fill('dev-user');
    await panel.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(panel.getByRole('alert')).toHaveText('the owner is not a member of their session');

    await panel.getByRole('button', { name: `Remove ${colleague}` }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
    await expect(panel.getByText(colleague)).toHaveCount(0);
  });

  test('keeps Branch and Delete on the reader’s own conversation', async ({ page, isMobile }) => {
    await page.goto(`/c/${OWNED}`);
    await conversations(page, isMobile);
    await page.getByRole('button', { name: 'Actions for My solvent screen' }).click();
    await expect(page.getByRole('menuitem', { name: /Branch this conversation/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Delete conversation/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Leave/ })).toHaveCount(0);
  });
});
