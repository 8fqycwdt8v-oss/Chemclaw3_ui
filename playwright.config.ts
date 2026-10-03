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
/**
 * The HTML sandbox's listener (wave 3) — a second origin, as in a deployment, so the browser suite
 * proves the isolation with the real headers and a real cross-origin frame. `127.0.0.1` on both
 * sides because the app is reached at `baseURL` below, and `APP_ORIGIN` must be that origin
 * exactly: it is the one the sandbox shell takes content from and may be framed by.
 */
const SANDBOX_PORT = 4323;

/**
 * A second BFF with `HTML_SCRIPTS_DEFAULT=off` — the kill switch — over the same fixture service.
 *
 * The default (`on`) is what every other spec runs under, so the switch would otherwise be proved
 * only by a unit test of the view, and "no script runs and no UDP leaves" is a property of a real
 * browser. Its own app and sandbox ports, because both origins are part of what is configured:
 * `e2e/sandbox.spec.ts` opens it at exactly `SCRIPTS_OFF_PORT`.
 */
const SCRIPTS_OFF_PORT = 4324;
const SCRIPTS_OFF_SANDBOX_PORT = 4325;

/**
 * Which client build the BFF serves here.
 *
 * `dist/client-dev-auth` by default, not `dist/client`: this suite runs unauthenticated, so it
 * needs the bundle built with `ALLOW_DEV_AUTH=true` — and that bundle must never be the one
 * `npm start` serves, which is what it was when both builds shared an output directory. The gate
 * (`scripts/ci.mjs`) builds it and passes this through; run it by hand with
 * `ALLOW_DEV_AUTH=true CLIENT_OUT_DIR=dist/client-dev-auth npm run build:client` first.
 */
const CLIENT_DIR = process.env.CLIENT_DIR ?? 'dist/client-dev-auth';

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
  //
  // `oidc-mock.spec.ts` likewise belongs to its own config (`playwright.oidc-mock.config.ts`): it
  // signs in through a real authority and needs a sibling Chemclaw3_mock checkout to be one.
  //
  // `e2e/kind/` is the whole-system workflow suite (`playwright.kind.config.ts`) and needs a
  // running kind cluster; nothing in it can pass against the fixture service.
  testIgnore: [/(full-stack|oidc-mock)\.spec\.ts/, /[\\/]kind[\\/]/],
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

  webServer: [
    {
      // BIND_HOST is explicit rather than left to default: the BFF refuses to serve AUTH_MODE=dev on
      // a non-loopback bind, and this suite runs unauthenticated. Binding loopback is the honest way
      // to satisfy that — the server really is only reachable from this machine — rather than
      // setting ALLOW_INSECURE_AUTH and teaching the test harness to wave the check through.
      command: `node --experimental-strip-types e2e/fixture-service.ts ${FIXTURE_PORT} & CHEMCLAW_API_URL=http://127.0.0.1:${FIXTURE_PORT} PORT=${PORT} BIND_HOST=127.0.0.1 APP_ORIGIN=http://127.0.0.1:${PORT} SANDBOX_ORIGIN=http://127.0.0.1:${SANDBOX_PORT} SANDBOX_PORT=${SANDBOX_PORT} CLIENT_DIR=${CLIENT_DIR} node dist/server.js`,
      url: `http://127.0.0.1:${PORT}/api/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // The kill switch, beside the default. Its own `/healthz` (not `/api/healthz`) as the
      // readiness URL: that one is the BFF's own, so this server does not wait on the fixture the
      // first command starts.
      command: `CHEMCLAW_API_URL=http://127.0.0.1:${FIXTURE_PORT} PORT=${SCRIPTS_OFF_PORT} BIND_HOST=127.0.0.1 APP_ORIGIN=http://127.0.0.1:${SCRIPTS_OFF_PORT} SANDBOX_ORIGIN=http://127.0.0.1:${SCRIPTS_OFF_SANDBOX_PORT} SANDBOX_PORT=${SCRIPTS_OFF_SANDBOX_PORT} HTML_SCRIPTS_DEFAULT=off CLIENT_DIR=${CLIENT_DIR} node dist/server.js`,
      url: `http://127.0.0.1:${SCRIPTS_OFF_PORT}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
