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

/**
 * A second BFF, in `bff` mode, for the sign-in specs.
 *
 * A separate process rather than a mode switch on the first: `AUTH_MODE` is read once at boot, and
 * the two modes serve different CSP headers and a different `/config.js`. Running both means the
 * dev-mode specs keep exercising the deployment shape they were written for.
 */
const BFF_PORT = Number(process.env.E2E_BFF_PORT ?? 8791);
const BFF_URL = `http://127.0.0.1:${BFF_PORT}`;
const ENTRA_PORT = Number(process.env.E2E_ENTRA_PORT ?? 8792);

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
      // Everything except the sign-in specs, which need the other server.
      testIgnore: /bffAuth\.spec\.ts/,
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
    {
      name: 'chromium-bff',
      testMatch: /bffAuth\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: BFF_URL,
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
          : {},
      },
    },
  ],

  // The mock backend stands in for Chemclaw3: a real turn needs a model credential, which CI does
  // not have, and the point of these tests is the frontend's behaviour on a stream rather than the
  // agent's answer. The BFF in front of it is the real one.
  webServer: [
    {
      command: `node e2e/mock-backend.mjs & CLIENT_DIR=dist/client PORT=${PORT} BIND_HOST=127.0.0.1 AUTH_MODE=dev CHEMCLAW_API_URL=http://127.0.0.1:8789 node dist/server.mjs`,
      // `/api/readyz`, not `/healthz`. The latter is answered locally by the BFF without touching
      // the backend, so it went green the moment the BFF bound its port — while the mock might not
      // be listening yet, and the first spec (which asserts "connected") raced a 502. This probe
      // traverses the proxy, so readiness means the whole chain is up.
      url: `${BASE_URL}/api/readyz`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // The same built bundle and the same mock backend, in front of a mock identity provider.
      // `ENTRA_AUTHORITY_HOST` on loopback is what `validateConfig` permits without HTTPS — see
      // its comment; anything else must be https, so this cannot be how a real deployment leaks.
      command:
        `node e2e/mock-entra.mjs & CLIENT_DIR=dist/client PORT=${BFF_PORT} BIND_HOST=127.0.0.1 ` +
        `AUTH_MODE=bff CHEMCLAW_API_URL=http://127.0.0.1:8789 ` +
        `ENTRA_AUTHORITY_HOST=http://127.0.0.1:${ENTRA_PORT} ENTRA_TENANT_ID=e2e-tenant ` +
        `ENTRA_CLIENT_ID=e2e-client ENTRA_CLIENT_SECRET=e2e-secret ` +
        `API_SCOPE=api://e2e-api/Chat.Access PUBLIC_ORIGIN=${BFF_URL} ` +
        `SESSION_SECRET=an-end-to-end-session-secret-of-adequate-length ` +
        `node dist/server.mjs`,
      url: `${BFF_URL}/api/readyz`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
