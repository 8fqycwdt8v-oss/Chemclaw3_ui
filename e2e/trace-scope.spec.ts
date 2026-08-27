import { expect, test } from '@playwright/test';
import { toolNames, traceText } from './trace.ts';

/**
 * The scoping that `e2e/full-stack.spec.ts` now depends on, proven in the tier that runs in CI.
 *
 * The four-repo suite cannot run on a push — it needs Postgres, Temporal, the Chemclaw3-mcp fleet,
 * the Chemclaw3_mock services and a real model behind the front door. Its assertions were
 * therefore the least-checked in the repository at exactly the moment they were most trusted, and
 * two of them turned out to be satisfied by the question the test had just typed.
 *
 * This test moves the *mechanism* those assertions rest on into the fixture tier, where it is
 * checked on every push against a real browser: the reader must see what the agent did and must
 * not see what the user asked. It is deliberately written the way the defect presents — a question
 * containing a tool name that this turn does not call — because that is the case a page-wide read
 * passes and a scoped read fails.
 */

/** A tool name the scripted fixture turn never calls, typed into the question on purpose. */
const NOT_CALLED = 'predict_forward_reaction';
/** A tool name the scripted fixture turn does call. */
const CALLED = 'screen_hazards';

test('the trace reader sees the tools, not the question', async ({ page }) => {
  await page.goto('/');
  await page
    .getByPlaceholder(/Ask about a reaction/)
    .fill(`Use ${NOT_CALLED} on this, and tell me the pKa of acetic acid.`);
  await page.getByRole('button', { name: 'Send' }).click();

  const answer = page.getByRole('article', { name: 'Assistant answer' }).last();
  await expect(answer).toContainText('4.76', { timeout: 15_000 });

  // The premise, asserted rather than assumed: the page really does contain the tool name the
  // question carried, so a body-wide read WOULD match it. Without this the test below could pass
  // for the boring reason that the string was never on the page at all.
  const body = (await page.locator('body').textContent()) ?? '';
  expect(body, 'the question is not on the page; this test would prove nothing').toContain(
    NOT_CALLED,
  );

  const trace = await traceText(page);

  // The assertion the full-stack suite's four broken scenarios needed and did not have.
  expect(trace, `the question leaked into the trace read: ${trace.slice(0, 200)}`).not.toContain(
    NOT_CALLED,
  );
  // And it is scoped without being empty — a reader that returned '' would satisfy the line above
  // while proving nothing, which is the other way to write a test that cannot fail.
  expect(trace).toContain(CALLED);
});

test('the tool names are the calls the turn made', async ({ page }) => {
  await page.goto('/');
  // Every word here is English prose. None of it is a `snake_case` identifier, which is what makes
  // the extraction below a claim about the agent rather than about the typing.
  await page
    .getByPlaceholder(/Ask about a reaction/)
    .fill('Screen this azide and tell me about the hazards.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('article', { name: 'Assistant answer' }).last()).toContainText(
    '4.76',
    { timeout: 15_000 },
  );

  const names = await toolNames(page);

  expect(names, `tools read from the trace: ${names.join(', ')}`).toContain(CALLED);
  // The fixture's turn also refuses one call at the plan gate — a `tool_failed` row, which is a
  // different renderer and was never once reached by a browser before this fixture carried it.
  expect(names).toContain('submit_qm_job');
});
