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

test('a report is watched being written, then becomes the artefact', async ({ page, isMobile }) => {
  // The column exists at `lg` only, and a draft opens nothing on a phone — the same rule as a new
  // artefact, which the test above already holds for the mobile project. What this one is about is
  // the text growing in the column and then being replaced, so it runs where the column is.
  test.skip(isMobile, 'the draft opens the column, which a phone does not have');
  await seedConversation(page, '4'.repeat(32));
  await page.goto(`/c/${CONVERSATION}`);

  await page.getByPlaceholder(/Ask about a reaction/).fill('Write up the amination as a report.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  const pane = page.getByRole('complementary', { name: 'Artefacts' });
  // The pane opened on the draft before the tool had run…
  await expect(
    pane.getByRole('heading', { name: 'Drafting “Amination process report”…' }),
  ).toBeVisible();
  await expect(pane.getByRole('status')).toContainText('being written now');
  // …and the text grows in it: the summary first, the next section later.
  await expect(pane).toContainText('The Buchwald–Hartwig amination ran in 2-MeTHF');
  await expect(pane).toContainText('Isolated yield was 82 %');
  // Not a document yet: nothing to revise, export or compare.
  await expect(pane.getByRole('combobox', { name: 'Revision' })).toHaveCount(0);

  // Then the `exhibit` frame lands it: the real artefact, with its revision and its whole text.
  await expect(pane.getByRole('heading', { name: /^Drafting/ })).toHaveCount(0);
  // The artefact's own title (the document's `# …` renders a level lower, inside it).
  await expect(
    pane.getByRole('heading', { level: 2, name: 'Amination process report', exact: true }),
  ).toBeVisible();
  await expect(pane.getByRole('combobox', { name: 'Revision' })).toContainText('r1 · agent');
  await expect(pane).toContainText('Repeat with CPME to compare the work-up.');
  await expect(
    page.getByRole('button', { name: 'Open artefact Amination process report' }),
  ).toBeVisible();
});

test('a 3D structure turns under the keyboard, reads as a table, and downloads as XYZ', async ({
  page,
  isMobile,
}) => {
  // A conversation that already holds two geometry artefacts (`GEOMETRY_SESSION` in the fixture):
  // one inline, one citing the calculation file it came from — read through the calc byte route.
  await seedConversation(page, '2'.repeat(32));
  await page.goto(`/c/${CONVERSATION}`);
  // Nothing opened it: the reader does, from the top bar.
  if (isMobile) {
    await page.getByRole('button', { name: 'Artefacts (2)' }).click();
  } else {
    await page.getByRole('button', { name: 'Show artefacts (2)' }).click();
  }
  const pane = isMobile
    ? page.getByRole('dialog', { name: 'Artefacts' })
    : page.getByRole('complementary', { name: 'Artefacts' });
  await pane.getByRole('combobox', { name: 'Artefact' }).selectOption('xb-9e0000000000a001');
  await expect(pane.getByRole('heading', { name: 'Optimised water' })).toBeVisible();

  const drawing = pane.getByRole('img', { name: /^Water, GFN2-xTB: H2O; 3 atoms, 2 bonds/ });
  await expect(drawing).toBeVisible();
  const viewer = pane.getByRole('application', { name: /arrow keys turn it/ });
  const before = await drawing.innerHTML();
  await viewer.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => drawing.innerHTML()).not.toBe(before);

  // The accessible reading: every atom with its coordinates, the highlighted one said in words.
  await pane.getByText('Atom table (3)').click();
  const table = pane.getByRole('region', { name: 'Water, GFN2-xTB — atoms and coordinates' });
  await expect(table.getByRole('row')).toHaveCount(4);
  await expect(table.getByRole('row').nth(1)).toContainText('O — highlighted');

  // The service's `.xyz`, through the BFF's `FMT` whitelist.
  await pane.getByRole('button', { name: 'Export' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'XYZ coordinates (.xyz)' }).click();
  expect((await download).suggestedFilename()).toBe('optimised-water.xyz');

  // The cited one: drawn from the calc store's bytes, which the reader can also take away (C4).
  await pane.getByRole('combobox', { name: 'Artefact' }).selectOption('xb-9e0000000000a002');
  await expect(
    pane.getByRole('img', { name: /^Ethanol conformer: C2H6O; 9 atoms, 8 bonds/ }),
  ).toBeVisible();
  const file = page.waitForEvent('download');
  await pane.getByRole('button', { name: 'Download xtbopt.xyz' }).click();
  expect((await file).suggestedFilename()).toBe('xtbopt.xyz');
});
