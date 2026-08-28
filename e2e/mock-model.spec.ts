import { expect, test } from '@playwright/test';
import { ask, composer } from './live-ui.ts';
import { toolNames, traceRegion, traceText } from './trace.ts';

/**
 * The deterministic live tier: the real stack, a scripted model.
 *
 * There are three browser suites in this repository and each answers a question the other two
 * cannot:
 *
 *  * `playwright.config.ts` over `e2e/fixture-service.ts` — "does the client behave correctly given
 *    well-formed frames". Fast, hermetic, runs on every push, and traverses no backend at all.
 *  * `playwright.full-stack.config.ts` over `e2e/full-stack.spec.ts` — "does a chemist's question
 *    reach a real tool and come back". A *real* model chooses the tool there, which is precisely
 *    its value and precisely why it cannot be made repeatable.
 *  * **this file** — "does a KNOWN sequence of model output drive the whole chain correctly". The
 *    stack is real: the front door, the LangGraph turn, the tool middleware, Postgres, Temporal,
 *    the BFF, the SPA. Only the model is scripted, by `chemclaw.cli.mock_llm` on 127.0.0.1:8820,
 *    which selects a behaviour from a literal `[[marker]]` anywhere in the message.
 *
 * ## What the scripting buys, and what it forfeits
 *
 * It buys the turn *shapes* a real model will not produce on request: six parallel calls in one
 * turn, a turn that writes no prose at all, a unicode payload driven through the streaming
 * assembler. Every one of those has been a live defect in this family, and none is reachable by
 * prompting.
 *
 * It forfeits routing. Whether a solvent question reaches the props server is a model decision, and
 * a scripted turn that calls `solvent_properties` measures the script. So scenarios 2, 3, 4 and 5
 * of the full-stack suite are NOT carried over here — not because they are unimportant, but
 * because this tier would answer them dishonestly.
 *
 * ## What is out of scope for this tier, and is not-run rather than skipped-green
 *
 * **`mock-vendor` and the seeded ELN/ORD scenarios are not covered here, because `Chemclaw3_mock`
 * is not in the session this tier is written for.** There is deliberately no `test.skip` standing
 * in for them: a skipped test reports green in the summary line most people read, and this
 * repository has already been bitten once by a suite whose assertions could not fail. Those
 * journeys are the full-stack suite's scenarios 4 and 5 and they stay there. If `Chemclaw3_mock`
 * later joins this tier's bring-up, they arrive here as new tests with real assertions.
 *
 * ## The assertion rule
 *
 * **Mechanical facts only** — a tool identifier read out of the SCOPED trace (`e2e/trace.ts`), an
 * HTTP status, a visible role. Never the prose of an answer: each behaviour's `text` is a fixture
 * in `chemclaw/cli/storm_behaviours.py`, so asserting "Unicode survived the round trip." would
 * measure that string and nothing else. And never `page.locator('body')` — see the comment in
 * `e2e/full-stack.spec.ts` about the two scenarios that were satisfied by the question the test had
 * just typed.
 *
 * Run it with the stack already up (Chemclaw3 brings it up; this config starts nothing):
 *   npm run test:e2e:mock-model
 */

/** Assertion message that names what the turn actually did, so a red run is diagnosable. */
const used = (names: string[]): string =>
  `tools called by this turn: ${names.join(', ') || 'none'}`;

/**
 * The unicode `[[h-unicode]]` puts into `find_notes`'s argument.
 *
 * Transcribed from `storm_behaviours.py` rather than imported — this repository cannot import from
 * that one, and a literal that has to agree with a literal is the honest shape of a cross-repo
 * contract. Four scripts, a middle dot and an astral-plane emoji: the byte widths that break a
 * naive assembler are all present.
 */
const UNICODE_ARGUMENT = '咖啡因 · Ω · 🧪 · ünïcødé';

test('1 · the shell paints against the real front door', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Chemclaw', level: 1 })).toBeVisible();
  await expect(composer(page)).toBeVisible();

  // The connection badge is the one that would have caught the two dev-path defects the full-stack
  // suite was written after: a dead BFF and a header-stripping proxy both surface here as
  // "unreachable". Scripting the model changes nothing about either.
  await expect(page.getByText('unreachable')).toHaveCount(0);
  expect(errors, `page errors on load: ${errors.join(' | ')}`).toEqual([]);
});

test('2 · a marker-driven turn calls exactly the tools its behaviour scripts', async ({ page }) => {
  await page.goto('/');
  await ask(page, '[[a-retrieval]] which notes cover amide coupling?');

  const names = await toolNames(page);

  // `a-retrieval` declares three calls, in this order: find_notes, gather_evidence, expand_note.
  // Reaching all three means the marker selected the behaviour, the mock encoded three calls, the
  // streaming assembler reassembled three, the middleware chain admitted three, and the trace
  // rendered three. That is the whole chain, and no part of it is the model's judgement.
  for (const tool of ['find_notes', 'gather_evidence', 'expand_note']) {
    expect(names, used(names)).toContain(tool);
  }

  // And the other direction, which is what makes the line above a claim about THIS turn rather
  // than about some ambient list: tools other behaviours script are absent. Deliberately not an
  // exact set equality — `toolNames` extracts every snake_case token in the trace region, and a
  // future row growing an identifier of its own would then fail a test that is not about it.
  for (const tool of ['compute_reaction_energy', 'find_past_jobs']) {
    expect(names, used(names)).not.toContain(tool);
  }
});

test('3 · six parallel calls in one turn all reach the trace', async ({ page }) => {
  await page.goto('/');
  await ask(page, '[[c-parallel]] run the probe set');

  // `toolNames` is a Set and every one of these six calls is `find_notes`, so it collapses them to
  // one — correct for "which tools ran", useless for "how many". Counting rows in the trace text is
  // what answers this: each tool_call row prints the raw name once, in its own mono span, and
  // `toolLabel` renders the human half as "Find notes" with no underscore.
  const trace = await traceText(page);
  const rows = trace.match(/\bfind_notes\b/g) ?? [];

  // Exactly six, not "at least". The behaviour declares six calls delivered in three argument
  // fragments each, so five means one was lost between the socket and the rail, and seven means
  // the fragment reassembly announced one call twice — the hazard `_chat_stream` documents at
  // length and the reason it never repeats a call's `name` on a continuation fragment. Both are
  // silent defects a real model cannot be asked to reproduce.
  expect(rows.length, `find_notes rows in the trace: ${rows.length}\n${trace}`).toBe(6);
});

test('4 · a durable job is launched and tracked', async ({ page }) => {
  await page.goto('/');
  await ask(page, '[[d-collide]] compute the reaction energy for the ammonia synthesis');

  // The launch. `compute_reaction_energy` is the `calc` bundle's durable job, and `job_started`
  // renders "Started <kind>" plus the job's own id — neither of which the question contains.
  const launched = await toolNames(page);
  expect(launched, used(launched)).toContain('compute_reaction_energy');
  expect(await traceText(page), `no durable job was started; ${used(launched)}`).toMatch(
    /\bStarted\b/,
  );

  // The tracking, as a second scripted turn rather than as a wait: `d-status` calls
  // `find_past_jobs`, so the agent asking the registry what has run is itself a checked fact.
  await ask(page, '[[d-status]] what reaction jobs have run?');
  const tracked = await toolNames(page);
  expect(tracked, used(tracked)).toContain('find_past_jobs');

  // And the durable panel is the product surface for long work — a job that runs but never appears
  // there is invisible to the chemist who started it. Asserted on the panel's own H2, because the
  // sidebar control is a button and an assertion that matched it would be satisfied by the thing
  // just clicked.
  await page.getByRole('button', { name: /Durable runs/ }).click();
  await expect(page.getByRole('heading', { name: 'Durable runs', level: 2 })).toBeVisible();
  // Resolved against the real registry rather than sitting on its loading state. Deliberately not
  // "a row for the job just launched": the registry holds finished runs, and a reaction-energy job
  // launched seconds ago has not finished.
  await expect(page.getByText('Reading the registry…')).toHaveCount(0);
});

test('5 · a turn that writes no prose fails loudly rather than blankly', async ({ page }) => {
  await page.goto('/');
  await ask(page, '[[f-no-text]] find the silent notes');

  // `f-no-text` runs a tool and writes nothing. The service's `empty_answer` guard turns that into
  // an `error` event, and this client fails the turn on it — so the surface owes the chemist an
  // alert. A silent empty answer is the worst shape a turn can take, because a user cannot retry
  // what never said it went wrong.
  //
  // Scoped to the header, which is where `failTurn`'s banner lives. A bare `getByRole('alert')`
  // would also match `StatusStrip`'s two members inside the answer card, and those announce things
  // a perfectly successful turn can carry — so the unscoped form could go green on a turn that did
  // not fail at all.
  await expect(page.locator('header').getByRole('alert')).toBeVisible();

  // Which of the two silent-turn surfaces was reached. This copy is what renders for a turn that
  // settled `done` with no text; its absence says the turn took the *error* path instead, which is
  // the whole distinction this scenario is about. The alert above cannot say that on its own —
  // a banner is raised by any failure, including one that never reached the model.
  await expect(page.getByText('The turn finished without producing any answer text.')).toHaveCount(
    0,
  );

  // And the tool really ran, which is what makes this the "tools ran, nothing written" shape rather
  // than a transport failure that died before the turn started.
  const names = await toolNames(page);
  expect(names, used(names)).toContain('find_notes');
});

test('6 · unicode survives the round trip', async ({ page }) => {
  await page.goto('/');
  await ask(page, `[[h-unicode]] search the notes for ${UNICODE_ARGUMENT}`);

  // The payload asserted on is the tool ARGUMENT, not the answer. The argument is emitted by the
  // mock, sliced by the SSE encoder, reassembled by the streaming assembler, persisted, pushed over
  // the BFF's proxy and rendered — every byte-width hazard in the chain. The answer is a fixture
  // string and asserting it would measure the fixture.
  const region = await traceRegion(page);
  // The arguments live one disclosure in, so they are not in the rail's `innerText` until opened.
  // "Expand all" is the panel's own control; clicking it is what a reader does.
  await region.getByRole('button', { name: 'Expand all' }).click();
  await expect(
    region.getByRole('region', { name: 'Arguments to find_notes' }),
    'the unicode argument did not survive the round trip into the trace',
  ).toContainText(UNICODE_ARGUMENT);
});

test('7 · the review queue renders against the real service', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Review queue/ }).click();

  // That the human-validation surface exists and loads is the integration claim; whether it holds a
  // particular proposal is not, and pinning this to one would make it measure the agent. Both
  // headings belong to the panel and to nothing else — `getByText(/Review queue/)` would resolve to
  // the sidebar button this test just clicked, which is how the full-stack version of this once
  // passed with the service down.
  await expect(
    page.getByRole('heading', { name: 'Notes waiting for review', level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Holds waiting on a decision', level: 2 }),
  ).toBeVisible();

  // Both lists resolved rather than sitting on their loading copy. Note what this still cannot
  // claim: both components fall back to an empty list on a failed fetch, so a healthy empty queue
  // and a dead service are indistinguishable from here. Closing that is a `src/components` change,
  // recorded rather than papered over with an assertion that reads stronger than it is.
  await expect(page.getByText('Reading the review queue…')).toHaveCount(0);
  await expect(page.getByText('Looking for holds…')).toHaveCount(0);
});

test('8 · /readyz reports the connectors this tier depends on', async ({ request }) => {
  const res = await request.get('/api/readyz');
  expect(res.ok(), `readyz returned ${res.status()}`).toBe(true);

  const body = JSON.stringify(await res.json());

  // Deliberately NOT the full-stack suite's eight-connector list. That list is what
  // `make live-e2e-full-stack` brings up; this tier's bring-up is smaller, and repeating a list
  // nothing here requires would make the test fail for a reason unrelated to anything it asserts.
  // `calc` is named because scenario 4 launches `compute_reaction_energy` through it — so this is
  // exactly the readiness this file's own scenarios depend on, and no more.
  expect(body, 'calc missing from /readyz').toContain('calc');
  // `unreachable` anywhere is the real failure: a connector that is probed and does not answer.
  expect(body).not.toContain('unreachable');
});
