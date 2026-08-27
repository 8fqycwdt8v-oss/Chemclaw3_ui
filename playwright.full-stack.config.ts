/**
 * The four-repo end-to-end suite.
 *
 * Unlike `playwright.config.ts`, this config starts **nothing**. It points at a stack that is
 * already up — Chemclaw3's `make live-e2e-full-stack`, which runs Postgres, Temporal, the
 * Chemclaw3-mcp fleet, Chemclaw3_mock's ELN/Entra/vendor mocks, this repo's BFF and SPA, and a real
 * Anthropic model behind the front door. There is no fixture service anywhere in the chain.
 *
 * That distinction is the whole point of the file. The fixture suite answers "does the client
 * behave correctly given well-formed frames"; this one answers "does a chemist's question reach a
 * real tool and come back". Both of the defects this suite was written after — a BFF that died at
 * import on a missing client build, and a Vite proxy that dropped `content-type` on SSE responses
 * — are invisible to the fixture suite, because the browser never traverses those code paths there.
 *
 * Serial and single-worker, deliberately. Every scenario costs a real model turn against a shared
 * front door with an admission cap; racing them buys nothing and makes a queue wait look like a
 * hang. Timeouts are correspondingly generous — a durable job or a cold tool is slow, not broken.
 *
 * Run it with the stack already up:
 *   make live-e2e-full-stack          # in the Chemclaw3 repo
 *   npm run test:e2e:full-stack       # here
 *
 * ## Why this is not in CI, and what it would take
 *
 * `.github/workflows/ci.yml` runs `npm run test:e2e` — the fixture config — and nothing here. That
 * is deliberate and it is also the reason the four scenarios below were allowed to rot into
 * assertions that could not fail: nothing re-read them, and their green was only ever consulted by
 * a human at the moment they most wanted to trust it. Adding a job that runs this on every push
 * would make it worse rather than better, so the conditions are written down instead of guessed at:
 *
 *  1. **Somewhere to run four repositories.** This suite needs Postgres, Temporal, the Chemclaw3-mcp
 *     fleet, Chemclaw3_mock's ELN/Entra/vendor mocks, this repo's BFF and SPA. That is
 *     `Chemclaw3`'s `make live-e2e-full-stack`, and it belongs on a self-hosted runner or a
 *     scheduled job with a compose bring-up — not on a `ubuntu-latest` push runner, where the
 *     bring-up alone would dominate the gate.
 *  2. **A model credential in CI, and a decision about spending it.** Every scenario costs a real
 *     turn against a real model. A per-push job spends that per push, per contributor, and
 *     `retries: 0` here means a flaky turn is a red gate rather than a retried one.
 *  3. **A verdict on non-determinism.** Whether a given turn calls a given tool is a model
 *     decision. The assertions below are written to survive that — a tool *family*, not a
 *     sentence — but "the model chose a different route" will still be a red run sometimes, and a
 *     gate that is sometimes red for a reason nobody can fix teaches people to ignore it.
 *
 * The shape that fits all three is a **scheduled** run (nightly, or on a release branch) against a
 * long-lived stack, reporting into an issue rather than blocking a push — plus what has already
 * been done here: the *mechanism* these scenarios depend on, the trace-scoped read in
 * `e2e/trace.ts`, is now covered by `e2e/trace-scope.spec.ts` in the fixture tier, which does run
 * on every push. That does not prove the stack is healthy. It does prove that when this suite says
 * a tool was called, it is reading the trace and not the question.
 */

import { defineConfig, devices } from '@playwright/test';

const UI_URL = process.env.CHEMCLAW_UI_URL ?? 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: './e2e',
  testMatch: /full-stack\.spec\.ts/,
  // One at a time: see the header. `fullyParallel` here would have scenarios competing for the
  // front door's admission slots and for one conversation's turn lock.
  fullyParallel: false,
  workers: 1,
  // No retries. A retry against a real model hides flakiness that is worth seeing, and each
  // attempt costs another turn.
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  timeout: 240_000,
  expect: { timeout: 30_000 },

  use: {
    baseURL: UI_URL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 30_000,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  },

  // Desktop only. The mobile viewport exercises layout, which the fixture suite already covers,
  // and doubling the count here would double the model spend for no new integration signal.
  projects: [
    {
      name: 'full-stack',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
  ],
});
