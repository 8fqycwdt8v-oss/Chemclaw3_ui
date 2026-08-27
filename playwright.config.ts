/**
 * Browser-level tests.
 *
 * `@playwright/test` was a declared dependency with a `test:e2e` script and no config and no specs,
 * so none of the interaction paths had browser coverage at all. The vitest suite covers the store,
 * the stream parser and the route whitelist; everything about layout, focus, the keyboard and the
 * theme was unverified.
 *
 * The `webServer` runs the real BFF against `e2e/fixture-service.ts` rather than stubbing the
 * network in the page. That is deliberate: the property most worth protecting here is that SSE
 * frames reach the browser *incrementally*, and a `page.route` fulfilment cannot produce timed
 * frames — it would prove nothing about buffering anywhere in the chain.
 */

import { defineConfig, devices } from '@playwright/test';

const PORT = 4321;
const FIXTURE_PORT = 4322;

export default defineConfig({
  testDir: './e2e',
  // **The exact complement of `playwright.full-stack.config.ts`'s `testMatch`.** That config selects
  // `full-stack.spec.ts` and nothing else; this one had no `testMatch` at all, so it also picked it
  // up — and ran the four-repo suite against `e2e/fixture-service.ts`, which replies with one
  // canned answer regardless of the question. Asked for the flash point of 2-MeTHF, the fixture
  // answered with the pKa of acetic acid and a `screen_hazards({"smiles":"CCO"})` call, so
  // "a solvent question reaches the props server" could not pass here however healthy the stack.
  //
  // Nobody had seen it: `format:check` was failing on `main`, so CI never reached this step.
  testIgnore: /full-stack\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
    // The container ships Chromium at a fixed path and PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set,
    // so `playwright install` is neither needed nor possible.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  },

  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } },
    },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],

  webServer: {
    // BIND_HOST is explicit rather than left to default: the BFF refuses to serve AUTH_MODE=dev on
    // a non-loopback bind, and this suite runs unauthenticated. Binding loopback is the honest way
    // to satisfy that — the server really is only reachable from this machine — rather than
    // setting ALLOW_INSECURE_AUTH and teaching the test harness to wave the check through.
    command: `node --experimental-strip-types e2e/fixture-service.ts ${FIXTURE_PORT} & CHEMCLAW_API_URL=http://127.0.0.1:${FIXTURE_PORT} PORT=${PORT} BIND_HOST=127.0.0.1 CLIENT_DIR=dist/client node dist/server.js`,
    url: `http://127.0.0.1:${PORT}/api/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
