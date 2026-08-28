/**
 * Reading "what did the agent actually do" out of the page, scoped so the answer can be *no*.
 *
 * This exists because of a defect worth stating plainly: `e2e/full-stack.spec.ts` read the tool
 * names it asserted on out of `page.locator('body').textContent()`. The body includes the
 * transcript, and the transcript includes the question the test had just typed into it — so for
 * two of the eight scenarios the assertion regex was satisfied by the question alone, before any
 * tool was called. Asked "search for commercial *suppliers*", the assertion `/supplier/` passed
 * with `mock-vendor` down, the ELN connector unreachable and the model refusing outright.
 *
 * A suite that cannot fail is worse than an absent one, because it is consulted precisely when the
 * stack is suspect. So the read is scoped to the trace disclosure's own content region, reached
 * through the trigger's `aria-controls` — the ARIA contract a disclosure has to satisfy anyway,
 * which means this cannot silently start reading the whole page again: if the attribute goes, the
 * helper throws rather than widening.
 *
 * Shared between the full-stack suite and `e2e/trace-scope.spec.ts`, which is the fixture-tier
 * test that proves the scoping actually holds — that one runs in CI, so the mechanism this file
 * depends on is checked on every push even though the four-repo suite is not.
 */

import { expect, type Locator, type Page } from '@playwright/test';

/** The last turn's trace disclosure, expanded, as a locator over its content region. */
export async function traceRegion(page: Page): Promise<Locator> {
  // The trigger's visible label is now the turn's summary ("6 steps · 2 tools · 4s"), which is
  // not a stable string to select on — so it names itself for assistive tech, and this reads that
  // name. Same contract as the `aria-controls` read below: an ARIA property the disclosure owes
  // anyway, rather than a test hook that can rot without anybody noticing.
  const trigger = page.getByRole('button', { name: /The agent’s work/ }).last();
  await expect(trigger, 'the last turn rendered no trace at all — no tool was called').toBeVisible({
    timeout: 30_000,
  });

  // Expanding is required: the rows are not in the DOM until the disclosure is open.
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  }

  const controls = await trigger.getAttribute('aria-controls');
  expect(
    controls,
    'the trace disclosure no longer names its content region; this helper would otherwise ' +
      'silently widen back to the whole page, which is the defect it exists to fix',
  ).toBeTruthy();

  // An attribute selector rather than `#id`, so an id containing a CSS metacharacter (Radix mints
  // them) needs no escaping pass that could itself be wrong.
  return page.locator(`[id="${controls}"]`);
}

/**
 * The text of the last turn's trace, and nothing else on the page.
 *
 * Notably NOT the answer either. The answer is the model's prose and can contain any word the
 * question contained; the trace is a record of calls.
 */
export async function traceText(page: Page): Promise<string> {
  // `innerText`, not `textContent`. The trace rows are flex containers whose children are a human
  // label, the raw tool name and its arguments — three separate elements with no whitespace
  // between them in the source. `textContent` concatenates those into `Screen hazardsscreen_hazards`
  // and the tool name stops being extractable; `innerText` returns the text as laid out, which is
  // both what a chemist reads and what leaves identifiers intact.
  return (await (await traceRegion(page)).innerText()) ?? '';
}

/**
 * The tool identifiers the last turn called.
 *
 * `snake_case` is the shape of every tool name in this system and is not a shape English prose
 * produces, so this stays a sound extraction even if a future trace row grows more prose around
 * it. It is also the assertion that a chemist's question can never satisfy by accident, which was
 * the whole failure: a question is words, a tool call is an identifier.
 */
export async function toolNames(page: Page): Promise<string[]> {
  const text = await traceText(page);
  return [...new Set(text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [])];
}
