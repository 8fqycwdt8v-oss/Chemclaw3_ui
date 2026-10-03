/**
 * 2 · A chat turn: the question goes out, the answer streams in, the tools it called are on the
 * card with what they returned, and its citations open the record they name.
 */

import {
  ask,
  bearerOf,
  expect,
  lastAnswer,
  NOTE_CHIP,
  newConversation,
  openTrace,
  realModel,
  runTag,
  say,
  send,
  stopButton,
  test,
  toolsCalled,
} from './lane.ts';

test('the answer streams in, and every tool it called is on the card with its result', async ({
  alice,
}) => {
  const { page } = alice;
  await newConversation(page);
  await send(
    page,
    say(
      '[[a-retrieval]] Which additive should I use for an EDC amide coupling, from our records?',
      'Which additive should I use for an EDC amide coupling? Search our internal records and ' +
        'notes, and cite the note ids you rely on.',
    ),
  );

  // Streaming, not buffered: the answer card exists and has text while the turn is still running
  // (the Stop button is the turn's own "still streaming").
  const answer = lastAnswer(page);
  await expect(stopButton(page)).toBeVisible();
  await expect(answer).toBeVisible();
  await expect(stopButton(page)).toBeHidden({ timeout: 240_000 });
  await expect(answer).not.toBeEmpty();
  if (!realModel()) {
    await expect(answer).toContainText('The record covers the additive choice');
  }

  // The card names each tool by its identifier and shows what it returned — a preview region per
  // call, non-empty, which is the difference between "a tool was called" and "a tool answered".
  const names = await toolsCalled(page);
  const trace = await openTrace(page);
  const expected = realModel()
    ? names.filter((n) => /find_notes|gather_evidence|expand_note|search/.test(n))
    : ['find_notes', 'gather_evidence', 'expand_note'];
  expect(expected.length, `tools called: ${names.join(', ')}`).toBeGreaterThan(0);
  for (const tool of expected) {
    const preview = trace.getByRole('region', { name: `Result preview from ${tool}` }).first();
    await expect(preview, `${tool} has no result on the card`).not.toBeEmpty();
  }
  // No step of a healthy turn reads as a failure.
  await expect(trace.getByText(/\bfailed\b/)).toHaveCount(0);

  // And a result opens in full ("full results viewable"): the trace keeps a preview, the panel
  // keeps the whole thing.
  await trace.getByRole('button', { name: 'See the full result' }).first().click();
  const full = page.getByRole('dialog');
  await expect(full).toBeVisible();
  await expect(full).not.toBeEmpty();
  await page.keyboard.press('Escape');
});

test('a citation in the answer opens the record it names', async ({ alice }) => {
  // On the mock, `[[e2e:cite]]` searches first (`gather_evidence` on an amide-coupling anchor, plus
  // `find_notes`) and writes the first record and note the tools returned into its prose — so the
  // chip, the id it carries and the sheet it opens are all the service's, not the script's.
  const { page } = alice;
  const tag = runTag();
  await newConversation(page);
  await ask(
    page,
    say(
      `[[e2e:cite]] ${tag} EDC amide couplings`,
      `${tag}: Search our ELN records for amide couplings run with EDC, and cite each record you ` +
        'use by its id exactly as the search returned it.',
    ),
  );
  const chip = lastAnswer(page)
    .getByRole('button', { name: /^(?:reaction|playbook|failure|rxn|compound|campaign)-/ })
    .first();
  await expect(chip, 'the answer carries no clickable citation').toBeVisible();
  if (!realModel()) {
    // The script cites one ELN/ORD record and one knowledge note; both must be chips.
    await expect(
      lastAnswer(page).getByRole('button', { name: /^reaction-/ }),
      'no ELN/ORD record (reaction-…) chip',
    ).not.toHaveCount(0);
    await expect(
      lastAnswer(page).getByRole('button', { name: NOTE_CHIP }),
      'no knowledge-note chip',
    ).not.toHaveCount(0);
  }
  const id = (await chip.textContent())!.trim();
  await chip.click();
  const sheet = page.getByRole('dialog', { name: new RegExp(`Note ${id.replace(/[.]/g, '\\.')}`) });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('That note could not be read')).toHaveCount(0);
  await expect(sheet).not.toBeEmpty();
});

/**
 * A citation-only record in the mock's data: the ORD Suzuki flow HTE import names its species
 * without structures, so core ingests those runs as `citation-only` (5,760 of them on the kind
 * cluster) and cites them as `reaction-eln-ord.<id>` (owner decision: ORD is citable).
 */
const CITATION_ONLY = 'reaction-eln-ord.suzuki-flow-hte-04620';

test('a citation-only ELN record says its structure was not given by the source', async ({
  alice,
}) => {
  // On the mock, `[[e2e:cite]]` with a `reaction-…` id in the message looks that record up with
  // `expand_note` and cites it only if the lookup returned it.
  const { page } = alice;
  const tag = runTag();
  await newConversation(page);
  await ask(
    page,
    say(
      `[[e2e:cite]] ${tag} ${CITATION_ONLY}`,
      `${tag}: Look up our ORD record suzuki-flow-hte-04620 from the Suzuki flow HTE import and ` +
        'cite it by its record id exactly as the search returns it. Do not summarise it; just ' +
        'cite it.',
    ),
  );
  const chip = lastAnswer(page)
    .getByRole('button', { name: /^reaction-/ })
    .first();
  await expect(chip, 'the answer cites no ELN/ORD record (reaction-…) as a chip').toBeVisible();
  await chip.click();
  const sheet = page.getByRole('dialog', { name: /^Note reaction-/ });
  await expect(sheet.getByText(/structure not given by the source/i).first()).toBeVisible();
});

test('a citation-only record, read through the BFF, discloses its tier', async ({ alice }) => {
  // The service half of the scenario above, which runs on every lane: the record a chip would open
  // says "structure not given by the source". Read with the page's own bearer, through the BFF —
  // the same request `CitationChip` → `NoteSheet` makes.
  const { page } = alice;
  const bearer = await bearerOf(page);
  const res = await page.request.get(`/api/notes/${CITATION_ONLY}`, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
  expect(res.status(), `GET /notes/${CITATION_ONLY}`).toBe(200);
  const body = await res.text();
  expect(body).toMatch(/structure not given by the source/i);
  expect(body).toMatch(/citation-only/i);
});
