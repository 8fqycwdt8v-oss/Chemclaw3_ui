import { expect, test, type Page } from '@playwright/test';

/**
 * The artefact loop, end to end: the agent writes a table, the pane opens on it, the chemist
 * corrects a cell, revision 2 is theirs, and the comparison shows what they changed.
 *
 * Against the fixture's artefact state rather than a stubbed page route, so the request the app
 * makes is the one the fixture enforces: a revision posted against anything but the head is the
 * service's 409, and a write that sent no `parent_revision` would fail here rather than pass.
 *
 * One session per project (`e2e/fixture-service.ts`'s `EXHIBIT_SESSIONS`): both projects run at
 * once against one fixture process, and an edit is a write.
 *
 * The two projects take different paths to the same pane on purpose. At `lg` the agent's new
 * artefact opens the column beside the answer by itself; on a phone it must **not** — a sheet
 * sliding over the whole screen mid-answer is the app taking the screen away — so the mobile run
 * opens it from the card, which is the deliberate act.
 */

const STORAGE_KEY = 'chemclaw3.chat.v2.dev-user';
const CONVERSATION = 'e2e-artefacts';

async function seedConversation(page: Page, sessionId: string): Promise<void> {
  const state = {
    version: 3,
    state: {
      conversations: {
        [CONVERSATION]: {
          id: CONVERSATION,
          sessionId,
          title: 'Amination solvents',
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
          messages: [],
          contextLost: false,
          sessionOrigin: 'local',
        },
      },
      order: [CONVERSATION],
      activeId: CONVERSATION,
      jobFeed: [],
      notifyOnJobComplete: false,
    },
  };
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    [STORAGE_KEY, JSON.stringify(state)],
  );
}

test('the agent writes a table, the chemist corrects a cell, and the comparison shows it', async ({
  page,
  isMobile,
}) => {
  await seedConversation(page, (isMobile ? '6' : '7').repeat(32));
  await page.goto(`/c/${CONVERSATION}`);

  await page
    .getByPlaceholder(/Ask about a reaction/)
    .fill('Rank the amination solvents in a table.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  // The card in the answer, after the answer's text.
  const open = page.getByRole('button', {
    name: 'Open artefact Solvent ranking for the amination',
  });
  await expect(open).toBeVisible();

  const column = page.getByRole('complementary', { name: 'Artefacts' });
  let pane;
  if (isMobile) {
    // No column below `lg`, and nothing opened over the answer by itself.
    await expect(column).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Artefacts' })).toHaveCount(0);
    await open.click();
    pane = page.getByRole('dialog', { name: 'Artefacts' });
  } else {
    // At `lg` the new artefact opened the column on its own, beside the answer.
    pane = column;
  }
  await expect(pane).toBeVisible();
  await expect(
    pane.getByRole('heading', { name: 'Solvent ranking for the amination' }),
  ).toBeVisible();
  // The unit is in the header; the agent's revision carries its unverified figure.
  await expect(pane.getByRole('columnheader', { name: 'Yield (%)' })).toBeVisible();
  await expect(pane.getByRole('note')).toContainText('unchecked — not necessarily wrong');
  await expect(pane.getByRole('combobox', { name: 'Revision' })).toContainText('r1 · agent');

  // Correct one cell. Enter commits it as revision 2, bound to revision 1.
  await pane.getByRole('button', { name: 'Edit Yield (%), row 1: 82' }).click();
  const cell = pane.getByRole('textbox', { name: 'Yield (%), row 1' });
  await cell.fill('85');
  await cell.press('Enter');

  await expect(pane.getByRole('button', { name: 'Edit Yield (%), row 1: 85' })).toBeVisible();
  const picker = pane.getByRole('combobox', { name: 'Revision' });
  await expect(picker.locator('option:checked')).toHaveText(/^r2 · you · \d\d:\d\d \(latest\)$/);
  // A person's revision carries no transcription warning.
  await expect(pane.getByRole('note')).toHaveCount(0);

  // What changed, from the revision the agent wrote to the one the chemist did.
  await pane.getByRole('button', { name: 'Compare' }).click();
  const compare = pane.getByRole('region', { name: 'Compare revisions' });
  await expect(compare.getByText('rows[0].yield')).toBeVisible();
  await expect(compare).toContainText('1 change from revision 1 to revision 2');
});
