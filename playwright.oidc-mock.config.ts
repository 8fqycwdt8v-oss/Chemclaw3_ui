/**
 * The real browser sign-in, end to end, against Chemclaw3_mock's stand-in Entra tenant.
 *
 * Every other browser test here runs `AUTH_MODE=dev`: no sign-in, one shared principal. So the
 * production auth path — MSAL redirecting to an authority, the code coming back on
 * `/auth/callback`, PKCE redemption, the bearer on every `/api` call, the BFF forwarding it — had
 * no browser coverage at all, and a system test with two distinct people in it was impossible.
 * This lane runs that path with the **production** bundle (`dist/client`, not the dev-auth one)
 * behind the real BFF, against the mock tenant's authorize/token/logout endpoints.
 *
 * **Not part of `npm run ci` and not in the default suite** (`playwright.config.ts` ignores the
 * spec): it needs a Chemclaw3_mock checkout with its venv, and Python on the runner. It runs on
 * every pull request as the `oidc-mock` job of `.github/workflows/ci.yml`; by hand:
 *
 *   MOCK_DIR=../Chemclaw3_mock npm run provision:mock-tenant   # once: the mock's .venv
 *   npm run build
 *   MOCK_DIR=../Chemclaw3_mock npm run test:e2e:oidc-mock
 *
 * **Why the tenant is served over https with a throwaway certificate.** `@azure/msal-browser`
 * refuses an authority that is not https (`authority_uri_insecure`), loopback included, so there
 * is no http variant of this lane to run. The certificate is generated per run by `openssl`, and
 * only the browser contexts (`ignoreHTTPSErrors`) and the validating upstream (which trusts that
 * one certificate) ever see it.
 *
 * Four processes, one per hop: the mock tenant (https), `e2e/fixture-service.ts` (the canned
 * service), `e2e/oidc-upstream.ts` (validates each forwarded bearer the way Chemclaw3's front door
 * does, then hands the request to the fixture), and the BFF in `AUTH_MODE=msal` with
 * `ENTRA_AUTHORITY` pointed at the tenant.
 */

import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const BFF_PORT = 4341;
const FIXTURE_PORT = 4342;
const UPSTREAM_PORT = 4343;
const TENANT_PORT = 4344;
/** The HTML sandbox's listener: on here as in every shipped way to run the UI, so this lane signs
 *  in through a CSP whose `frame-src` holds the authority *and* the sandbox, as production's does. */
const SANDBOX_PORT = 4345;

const MOCK_DIR = resolve(process.env.MOCK_DIR ?? '../Chemclaw3_mock');
const CERT_DIR = join(tmpdir(), 'chemclaw-oidc-mock');
const CERT = join(CERT_DIR, 'cert.pem');
const KEY = join(CERT_DIR, 'key.pem');

export const TENANT = 'mock-tenant';
export const AUTHORITY = `https://127.0.0.1:${TENANT_PORT}/entra/${TENANT}`;
export const ISSUER = `${AUTHORITY}/v2.0`;
export const CLIENT_ID = 'chemclaw-ui-e2e';
export const AUDIENCE = 'api://chemclaw';
export const BFF = `http://127.0.0.1:${BFF_PORT}`;
export const UPSTREAM = `http://127.0.0.1:${UPSTREAM_PORT}`;

const certificate =
  `mkdir -p ${CERT_DIR} && openssl req -x509 -newkey rsa:2048 -nodes -days 1 ` +
  `-subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1 -keyout ${KEY} -out ${CERT} 2>/dev/null`;

const tenantEnv = [
  'MOCK_ENTRA_ENABLED=true',
  `MOCK_ENTRA_ISSUER=${ISSUER}`,
  `MOCK_ENTRA_AUDIENCE=${AUDIENCE}`,
  `MOCK_ENTRA_SPA_CLIENT_ID=${CLIENT_ID}`,
  `MOCK_ENTRA_REDIRECT_URIS=${BFF}/auth/callback`,
  'MOCK_ELN_SEED_ON_STARTUP=false',
  `MOCK_ELN_EXPORT_DIR=${join(CERT_DIR, 'eln')}`,
  `MOCK_ORD_EXPORT_DIR=${join(CERT_DIR, 'ord')}`,
].join(' ');

export default defineConfig({
  testDir: './e2e',
  testMatch: /oidc-mock\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  use: {
    baseURL: BFF,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command:
        `${certificate} && cd ${MOCK_DIR} && ${tenantEnv} exec .venv/bin/python -m uvicorn ` +
        `app.main:app --host 127.0.0.1 --port ${TENANT_PORT} ` +
        `--ssl-keyfile ${KEY} --ssl-certfile ${CERT} --log-level warning`,
      url: `${ISSUER}/.well-known/openid-configuration`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `node --experimental-strip-types e2e/fixture-service.ts ${FIXTURE_PORT}`,
      url: `http://127.0.0.1:${FIXTURE_PORT}/healthz`,
      reuseExistingServer: false,
    },
    {
      command:
        `OIDC_JWKS_URL=${AUTHORITY}/discovery/v2.0/keys OIDC_ISSUER=${ISSUER} ` +
        `OIDC_AUDIENCE=${AUDIENCE} OIDC_CA_FILE=${CERT} ` +
        `node --experimental-strip-types e2e/oidc-upstream.ts ${UPSTREAM_PORT} ${FIXTURE_PORT}`,
      url: `${UPSTREAM}/healthz`,
      reuseExistingServer: false,
    },
    {
      // The production client bundle — `dist/client`, which `scripts/assert-no-dev-auth.mjs`
      // holds to containing no dev-auth path — not the `client-dev-auth` build the default suite
      // serves.
      command:
        `AUTH_MODE=msal ENTRA_TENANT_ID=${TENANT} ENTRA_CLIENT_ID=${CLIENT_ID} ` +
        `API_SCOPE=${AUDIENCE}/Chat.Access ENTRA_AUTHORITY=${AUTHORITY} ` +
        `CHEMCLAW_API_URL=${UPSTREAM} PORT=${BFF_PORT} BIND_HOST=127.0.0.1 LOG_LEVEL=error ` +
        `APP_ORIGIN=${BFF} SANDBOX_ORIGIN=http://127.0.0.1:${SANDBOX_PORT} SANDBOX_PORT=${SANDBOX_PORT} ` +
        `CLIENT_DIR=${process.env.CLIENT_DIR ?? 'dist/client'} node dist/server.js`,
      url: `${BFF}/api/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
