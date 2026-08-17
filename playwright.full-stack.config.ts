/**
 * The four-repo end-to-end suite.
 *
 * Unlike `playwright.config.ts`, this config starts **nothing**. It points at a stack that is
 * already up — Chemclaw3's `make live-e2e-full-stack`, which runs Postgres, Temporal, the
 * Chemclaw3-mcp fleet, Chemclaw3_mock's HPC/ELN/vendor mocks, this repo's BFF and SPA, and a real
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
