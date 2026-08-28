/**
 * The deterministic live tier: the real stack, a scripted model.
 *
 * Like `playwright.full-stack.config.ts` and unlike `playwright.config.ts`, this config starts
 * **nothing**. The stack is brought up by the Chemclaw3 repository, with the front door pointed at
 * `chemclaw.cli.mock_llm` on 127.0.0.1:8820 instead of a real endpoint — an OpenAI-compatible mock
 * that selects a scripted turn from a literal `[[marker]]` in the message.
 *
 * What this tier answers that neither other one can: **that a KNOWN sequence of model output drives
 * the whole chain correctly.** The fixture tier never traverses the backend; the full-stack tier
 * traverses it with a real model, whose tool choice is a judgement and therefore not repeatable. A
 * scripted turn can be asked for the shapes a real model will not produce on request — six parallel
 * calls, a turn with no prose, a unicode payload through the streaming assembler — and each of
 * those has been a live defect in this family.
 *
 * `mock-vendor` and the seeded ELN/ORD journeys are **out of scope here**, because `Chemclaw3_mock`
 * is not part of this tier's bring-up. They are not-run, not skipped-green: `e2e/mock-model.spec.ts`
 * contains no `test.skip` standing in for them, and they remain the full-stack suite's scenarios 4
 * and 5. See that file's header.
 *
 * ## Why the concurrency numbers differ from the full-stack tier's
 *
 * That tier is `workers: 1`, and its header gives the reason: every scenario costs a real model
 * turn against a shared front door with an admission cap, so racing them buys nothing and makes a
 * queue wait look like a hang. **Neither half of that reasoning survives here.** A scripted turn
 * costs no tokens, and `storm_behaviours.py` puts at most 0.4 s of pretend thinking in front of the
 * behaviours this suite uses — so the wall clock is dominated by browser startup, which is exactly
 * what parallelism amortises. The same mock is driven at twelve concurrent turns by Chemclaw3's own
 * storm lane, so four browsers is well inside what the front door has been shown to take.
 *
 * Four rather than unbounded, though: the front door still has one admission cap and one Postgres
 * pool, and a suite that saturates them would report a capacity limit as a product defect. Each
 * test also takes its own page, so no two share a conversation or a turn lock.
 *
 * `retries: 0`, matching the full-stack tier and for its reason rather than its cost: **a retry
 * hides flakiness that is worth seeing.** It matters more here, not less — the whole claim of this
 * tier is determinism, so a scenario that only passes on the second attempt has falsified the
 * premise and must be allowed to say so.
 *
 * `timeout: 90_000` is the real bound on a hung turn. `ask()` in `e2e/live-ui.ts` waits up to 220 s
 * for the Stop button, which is the ceiling a real model needs; a scripted turn that has not
 * settled in 90 s is broken, and the test timeout is what says so promptly.
 *
 * Run it with the stack already up:
 *   make live-e2e-mock-model       # in the Chemclaw3 repo
 *   npm run test:e2e:mock-model    # here
 */

import { defineConfig, devices } from '@playwright/test';

const UI_URL = process.env.CHEMCLAW_UI_URL ?? 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: './e2e',
  testMatch: /mock-model\.spec\.ts/,
  // See the header. Each test drives its own page and its own conversation, so there is nothing
  // shared between them to serialise.
  fullyParallel: true,
  workers: 4,
  // No retries. A retry against a suite whose whole claim is determinism hides the one result worth
  // having.
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  timeout: 90_000,
  expect: { timeout: 20_000 },

  use: {
    baseURL: UI_URL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 20_000,
    // The container ships Chromium at a fixed path and PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set,
    // so `playwright install` is neither needed nor possible.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  },

  // Desktop only. What this tier measures is the chain behind the page, not its layout — the
  // fixture tier already runs a mobile viewport over every interaction path, and doubling the count
  // here would double the bring-up's load for no new integration signal.
  projects: [
    {
      name: 'mock-model',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
  ],
});
