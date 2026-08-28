/**
 * The two ways a live suite touches the product: find the composer, and ask it something.
 *
 * Both definitions used to live inside `e2e/full-stack.spec.ts`, which was fine while that file was
 * the only suite driving a running stack. It is not any more — `e2e/mock-model.spec.ts` drives the
 * same front door with the model scripted — and two copies of `ask()` are two chances to get "the
 * turn has settled" wrong in one of them. This is the same two-caller extraction `e2e/trace.ts`
 * already is, for the same reason: the *mechanism* a suite's assertions rest on belongs in one
 * file, so a fix reaches every caller and a defect is visible in one place rather than in whichever
 * copy somebody happened to read.
 *
 * Nothing here knows which tier is calling it, and in particular there is no per-tier timeout knob.
 * The settle wait below is a ceiling, not a sleep: a scripted turn clears it in seconds, and what
 * actually bounds a *hung* turn is each config's own `timeout` — 240 s for a real model, 90 s for a
 * scripted one. Parameterising it here would put a number in two places to say one thing.
 */

import { expect, type Locator, type Page } from '@playwright/test';

/** The composer, by the placeholder the shell has always used. */
export const composer = (page: Page): Locator => page.getByPlaceholder(/Ask about a reaction/);

/**
 * Ask one question and wait for the turn to fully settle.
 *
 * Settle is "the Send button is back", not "the composer is enabled": the composer unlocks briefly
 * between turns, and an assertion racing that gap reads a half-rendered answer. The Stop button is
 * present for exactly as long as a turn is streaming, so its disappearance is the honest signal.
 */
export async function ask(page: Page, question: string): Promise<string> {
  await composer(page).fill(question);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden({ timeout: 220_000 });
  const answer = page.getByRole('article', { name: 'Assistant answer' }).last();
  await expect(answer).not.toBeEmpty();
  return (await answer.textContent()) ?? '';
}
