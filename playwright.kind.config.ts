/**
 * Complete user workflows, in a real browser, against the whole system on a local kind cluster.
 *
 * Core's `deploy/kind/` (`make kind-up`) runs all four repositories from their production images
 * and the production Helm chart: the front door, the MCP fleet, Temporal, Postgres, the
 * Chemclaw3_mock ELN/ORD/Entra app, the scripted mock LLM, and this repo's BFF + SPA. This config
 * starts **nothing** and mocks **nothing** — no `page.route`, no fixture service. Every request a
 * scenario makes crosses the same hops a chemist's would.
 *
 * Where it differs from `playwright.full-stack.config.ts` (the host-process lane): that suite pins
 * one conversation through eight subsystem boundaries; this one walks *workflows* — sign in as two
 * people, share a session, approve a plan, follow a job to its result, reload mid-turn — each in a
 * fresh browser context so a red scenario does not take the others with it.
 *
 * **Not in CI and not in the default suite** (`playwright.config.ts` ignores `e2e/kind/`): it
 * needs a running cluster. Run it with the cluster up:
 *
 *   make kind-up                     # in the Chemclaw3 repo (devauth or oidc-mock)
 *   npm run test:e2e:kind            # here
 *
 * ## What the lane is, and how the suite knows
 *
 *  - **Auth mode** is read from the BFF's own `/config.js` at the start of the run (`authMode`
 *    `msal` → the oidc-mock mode, alice and bob sign in at the mock tenant; `dev` → one dev
 *    principal, and the two-person parts skip with the reason on the line).
 *  - **Model gateway** cannot be read from the stack (the front door answers the same either way),
 *    so it comes from the environment by the rule core's `deploy/kind/up.sh` applies:
 *    `CHEMCLAW_KIND_LLM=live` (or `CHEMCLAW_E2E_MODEL=real`) is a real model, anything else is the
 *    scripted mock. Against the mock a scenario drives the mock's behaviour markers (`[[a-cheap]]`,
 *    `[[f-slow]]`, and the `[[e2e:…]]` workflows — plan, remember/conditions, cite, long-job,
 *    slow; core `deploy/kind/README.md`) and asserts the wiring. The newest marked message in a
 *    conversation decides, and an unmarked follow-up inherits it. What only a model *deciding*
 *    something can show (that it would choose to plan, cite, or honour a preference) is the live
 *    lane's question; `requireRealModel` skips a claim that has no mock stand-in at all.
 *
 * Environment: `CHEMCLAW_UI_URL` (default http://127.0.0.1:15173), `CHEMCLAW_API_URL` (the front
 * door, default http://127.0.0.1:18000), `CHEMCLAW_KIND_AUTHORITY` (default the mock tenant on
 * https://127.0.0.1:18443/entra/mock-tenant).
 */

import { defineConfig, devices } from '@playwright/test';

/** What this suite knows about the cluster it is pointed at, handed to the specs as `metadata`. */
export interface KindLane {
  uiUrl: string;
  /** The front door, for what the BFF deliberately does not proxy (`/metrics`). */
  coreUrl: string;
  /** The mock tenant's authority, as the SPA's MSAL config names it. */
  authority: string;
  modelGateway: { kind: 'mock' | 'real'; reason: string };
}

function modelGateway(env: NodeJS.ProcessEnv): KindLane['modelGateway'] {
  const explicit = env.CHEMCLAW_E2E_MODEL?.trim().toLowerCase();
  if (explicit === 'mock' || explicit === 'real') {
    return { kind: explicit, reason: `CHEMCLAW_E2E_MODEL=${explicit}` };
  }
  if (explicit) throw new Error(`CHEMCLAW_E2E_MODEL must be "mock" or "real", not "${explicit}"`);
  const llm = env.CHEMCLAW_KIND_LLM?.trim().toLowerCase();
  if (llm === 'live') return { kind: 'real', reason: 'CHEMCLAW_KIND_LLM=live' };
  return {
    kind: 'mock',
    reason: llm
      ? `CHEMCLAW_KIND_LLM=${llm}`
      : 'CHEMCLAW_KIND_LLM is unset — up.sh defaults to the mock',
  };
}

const strip = (url: string): string => url.replace(/\/+$/, '');

const lane: KindLane = {
  uiUrl: strip(process.env.CHEMCLAW_UI_URL ?? 'http://127.0.0.1:15173'),
  coreUrl: strip(process.env.CHEMCLAW_API_URL ?? 'http://127.0.0.1:18000'),
  authority: strip(
    process.env.CHEMCLAW_KIND_AUTHORITY ?? 'https://127.0.0.1:18443/entra/mock-tenant',
  ),
  modelGateway: modelGateway(process.env),
};

export default defineConfig({
  testDir: './e2e/kind',
  testMatch: /\.spec\.ts$/,
  // One at a time. The scenarios are independent (each opens its own contexts and conversations),
  // but they share one front door with an admission cap and a per-actor turn cap: racing them
  // would make a queue wait look like a hang, and scenario 6 is *about* a queue.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-kind' }]],
  outputDir: 'test-results-kind',
  metadata: lane as unknown as Record<string, unknown>,
  // Gates the run on both `/readyz` answering 200 steadily — a suite started mid-rollout failed on
  // flapping probes, which read as product defects. See `e2e/kind/global-setup.ts`.
  globalSetup: './e2e/kind/global-setup.ts',
  timeout: 300_000,
  expect: { timeout: 30_000 },

  use: {
    baseURL: lane.uiUrl,
    // The mock tenant serves a per-cluster CA's certificate; only these contexts ever see it.
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 30_000,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  },

  projects: [
    {
      name: 'kind',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
  ],
});
