/**
 * End-to-end configuration.
 *
 * `test:e2e` was declared in package.json and `@playwright/test` was installed, but there was no
 * config and no spec anywhere — so the command failed and nothing exercised the app in a browser.
 *
 * The suite runs against the **built** artefact served by the real BFF, not against `vite dev`.
 * That is the point: the failures worth catching here — the runtime config script not loading,
 * the SPA fallback, SSE arriving unbuffered through the proxy — are all properties of the
 * production path, and the dev server does not have them.
 */

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 8790);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Untrimmed defaults are slow to fail; these are generous for a proxied SSE turn and no more.
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Honour a preinstalled browser when one is provided.
        //
        // Sandboxes and CI images frequently ship a Chromium that does not match the build number
        // this @playwright/test version would download, and re-downloading is often blocked
        // outright. Pointing at the existing binary is the documented escape hatch; unset, this is
        // `undefined` and Playwright resolves its own browser exactly as normal.
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
          : {},
      },
    },
  ],

  // The mock backend stands in for Chemclaw3: a real turn needs a model credential, which CI does
  // not have, and the point of these tests is the frontend's behaviour on a stream rather than the
  // agent's answer. The BFF in front of it is the real one.
  webServer: {
    command: `node e2e/mock-backend.mjs & CLIENT_DIR=dist/client PORT=${PORT} BIND_HOST=127.0.0.1 AUTH_MODE=dev CHEMCLAW_API_URL=http://127.0.0.1:8789 node dist/server.mjs`,
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
