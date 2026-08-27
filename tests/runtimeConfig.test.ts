/**
 * `/config.js` — the runtime-auth bridge — and the seam it sits on.
 *
 * `server/runtimeConfig.ts` declares `interface RuntimeConfig`. `src/env.ts` declares a second
 * `interface RuntimeConfig` with the same eight fields. Neither imports the other and nothing
 * checked them against each other, so they are two hand-written mirrors of one wire shape — exactly
 * the structure `tests/eventContract.test.ts` exists to police for events, and here it was
 * unpoliced. Renaming one field on the server side (`reviewerRoles` -> `reviewer_roles`, the shape
 * a backend rename lands in) left `tsc -b` at exit 0 and the whole suite green, while
 * `useIsReviewer` returned false for every signed-in user and the PR-gate surface went read-only
 * for the reviewers who hold the role.
 *
 * Two checks, because one alone would not have caught it:
 *
 *  - a **compile-time** one, which is what makes `npm run typecheck` the drift gate for the shape;
 *  - a **runtime** round trip through the emitted script, which is what makes `npm test` the gate
 *    for the values. The second is not redundant: the server could satisfy the interface and still
 *    emit the wrong bytes, and a type assertion cannot see `renderConfigScript`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig as ServerRuntimeConfig } from '../server/runtimeConfig.ts';
import type { RuntimeConfig as ClientRuntimeConfig } from '../src/env.ts';

/**
 * `true` only if `A` is assignable to `B`.
 *
 * Written as a conditional type rather than as a function argument so the failure is a type error
 * on an assignment — `Type 'false' is not assignable to type 'true'` — naming the two declarations,
 * rather than a red squiggle inside a helper nobody reads.
 */
type Assignable<A, B> = A extends B ? true : false;

/** The server may not declare a field the client does not read... */
const serverToClient: Assignable<ServerRuntimeConfig, ClientRuntimeConfig> = true;
/** ...and the client may not read a field the server does not send. */
const clientToServer: Assignable<ClientRuntimeConfig, ServerRuntimeConfig> = true;

/**
 * The environment the two halves are compared under.
 *
 * Every value is deliberately distinguishable from the default `src/env.ts` would fall back to, so
 * a field that fails to cross the seam reads as its fallback rather than as the value set here —
 * which is precisely how the real failure presents (`reviewerRoles` becoming `[]`, `apiScope`
 * becoming `''`). A fixture of defaults would pass with the bridge unplugged.
 */
const ENV: Record<string, string> = {
  AUTH_MODE: 'msal',
  ENTRA_TENANT_ID: 'tenant-from-the-server',
  ENTRA_CLIENT_ID: 'client-from-the-server',
  API_SCOPE: 'api://api-client-id/Chat.Access',
  APP_VERSION: '9.9.9-from-the-server',
  WARM_SESSIONS: 'false',
  REVIEWER_ROLES: 'Chemclaw.Reviewer,Chemclaw.Approver',
};

/** Boot the server half against `ENV` and hand back its config plus the script it would serve. */
async function renderFromEnv(): Promise<{
  config: ServerRuntimeConfig;
  script: string;
}> {
  for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
  vi.resetModules();
  const server = await import('../server/runtimeConfig.ts');
  return { config: server.runtimeConfig(), script: server.renderConfigScript() };
}

/**
 * Run the script the way `index.html` does, then read the SPA's config back.
 *
 * `new Function` rather than a hand-built object: the thing under test is the *bytes* the server
 * emits, so anything that parsed them by another route would be testing a second idea of what the
 * script says. The module is re-imported afterwards because `src/env.ts` resolves its config once,
 * at module scope, exactly as it does on a real page load.
 */
async function loadClientConfig(script: string): Promise<ClientRuntimeConfig> {
  delete window.__CHEMCLAW_CONFIG__;
  new Function(script)();
  vi.resetModules();
  const env = await import('../src/env.ts');
  return env.config;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  delete window.__CHEMCLAW_CONFIG__;
});

describe('the two RuntimeConfig declarations are one shape', () => {
  it('is assignable in both directions', () => {
    // The assertion is the *type* of these two constants, checked by `npm run typecheck`; this
    // test exists so the check has a name in the suite and cannot be deleted as dead code.
    expect(serverToClient && clientToServer).toBe(true);
  });
});

describe('what /config.js actually delivers', () => {
  it('carries every field across the seam, value for value', async () => {
    const { config, script } = await renderFromEnv();
    const client = await loadClientConfig(script);

    // Not `toMatchObject`: the point is that the two objects are the *same shape*, so a field the
    // server sends and the client drops, or vice versa, is a failure rather than a silent subset.
    expect(client).toEqual(config);
    expect(Object.keys(client).sort()).toEqual(Object.keys(config).sort());
  });

  it('delivers the values a rename would silently turn into defaults', async () => {
    // Spelled out one by one as well, because `toEqual` above names the whole object when it fails
    // and these three are the ones with a deployment-wide consequence: an empty `reviewerRoles`
    // hides the approve/reject controls from every reviewer, a wrong `apiScope` 401s every request
    // with a valid-looking token, and a wrong `entraTenantId` points MSAL at the wrong tenant.
    const { script } = await renderFromEnv();
    const client = await loadClientConfig(script);

    expect(client.reviewerRoles).toEqual(['Chemclaw.Reviewer', 'Chemclaw.Approver']);
    expect(client.apiScope).toBe('api://api-client-id/Chat.Access');
    expect(client.entraTenantId).toBe('tenant-from-the-server');
    expect(client.authMode).toBe('msal');
    // `false` and not the `true` default: a boolean that failed to cross reads as its fallback,
    // which for this one is the *on* state and therefore invisible.
    expect(client.warmSessions).toBe(false);
  });

  it('does not fall back to dev auth when the server said msal', async () => {
    // `scripts/assert-no-dev-auth.mjs` greps the bundle, not this script, so the only thing
    // standing between a mis-emitted `authMode` and an unauthenticated production SPA is here.
    const { script } = await renderFromEnv();
    expect(script).toContain('"authMode":"msal"');
    const client = await loadClientConfig(script);
    expect(client.authMode).not.toBe('dev');
  });

  it('escapes a value that would otherwise close the script tag', async () => {
    // The injection defence its own comment claims, executed. These values are operator-supplied
    // rather than user-supplied, which is why the escape is cheap insurance and not a control —
    // but an uncommented `replace` is exactly the line a refactor deletes.
    vi.resetModules();
    const { renderConfigScript } = await import('../server/runtimeConfig.ts');
    const script = renderConfigScript({
      authMode: 'dev',
      entraTenantId: '</script><script>window.pwned=1</script>',
      entraClientId: '',
      apiScope: '',
      apiBase: '/api',
      appVersion: 'dev',
      warmSessions: true,
      reviewerRoles: [],
    });

    expect(script).not.toContain('</script>');
    expect(script).toContain('\\u003c');

    // And it still round-trips: escaping must not corrupt the value it protects.
    const client = await loadClientConfig(script);
    expect(client.entraTenantId).toBe('</script><script>window.pwned=1</script>');
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });
});
