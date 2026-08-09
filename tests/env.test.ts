/**
 * Runtime config resolution — specifically, that it fails CLOSED.
 *
 * The bug this pins: `authMode` resolved with a trailing `: 'dev'`, so "the operator chose dev"
 * and "we never learned what the operator chose" were the same value. A `/config.js` that failed
 * to load therefore selected the provider that sends no `Authorization` header at all, and
 * `configProblems` — which only validated the `msal` branch — had nothing to say about it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { configProblems, resolveConfig, type ResolvedRuntimeConfig } from '../src/env.ts';

const withWindowConfig = (value: unknown): void => {
  (globalThis as { window?: unknown }).window = value === undefined ? {} : { __CHEMCLAW_CONFIG__: value };
};

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as { window?: unknown }).window;
});

/** `import.meta.env.DEV` is true under vitest, so a production build has to be simulated. */
const asProdBuild = (): void => {
  vi.stubEnv('DEV', false);
  vi.stubEnv('PROD', true);
};

describe('a missing /config.js', () => {
  it('does not silently become dev auth in a production build', () => {
    asProdBuild();
    withWindowConfig(undefined);
    const c = resolveConfig();
    expect(c.authModeSource).toBe('unresolved');
    // Fails closed onto msal-with-nothing-configured, which cannot accidentally work.
    expect(c.authMode).toBe('msal');
  });

  it('is reported as its own problem, naming /config.js rather than a tenant id', () => {
    asProdBuild();
    withWindowConfig(undefined);
    const problems = configProblems(resolveConfig());
    expect(problems[0]).toMatch(/\/config\.js/);
    expect(problems.length).toBeGreaterThan(0);
  });

  it('still defaults to dev in a development build, where there is no BFF to serve it', () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('PROD', false);
    withWindowConfig(undefined);
    const c = resolveConfig();
    expect(c.authMode).toBe('dev');
    expect(c.authModeSource).toBe('dev-build-default');
    expect(configProblems(c)).toEqual([]);
  });
});

describe('an explicit mode from the runtime config', () => {
  it('honours dev when the BFF actually said dev', () => {
    asProdBuild();
    withWindowConfig({ authMode: 'dev' });
    const c = resolveConfig();
    expect(c.authMode).toBe('dev');
    expect(c.authModeSource).toBe('runtime-config');
    // A deliberate dev deployment is not a configuration error — only an unresolved one is.
    expect(configProblems(c)).toEqual([]);
  });

  it('honours msal and then requires the rest of the msal settings', () => {
    asProdBuild();
    withWindowConfig({ authMode: 'msal' });
    const problems = configProblems(resolveConfig());
    expect(problems.some((p) => p.includes('ENTRA_TENANT_ID'))).toBe(true);
  });

  it('accepts a complete msal config', () => {
    asProdBuild();
    withWindowConfig({
      authMode: 'msal',
      entraTenantId: 't',
      entraClientId: 'c',
      apiScope: 'api://x/Chat.Access',
    });
    expect(configProblems(resolveConfig())).toEqual([]);
  });
});

describe('an invalid mode', () => {
  it('is a problem rather than a silent downgrade to dev', () => {
    asProdBuild();
    withWindowConfig({ authMode: 'MSAL' });
    const c = resolveConfig();
    expect(c.invalidAuthMode).toBe('MSAL');
    expect(configProblems(c).some((p) => p.includes('"MSAL"'))).toBe(true);
  });
});

describe('apiScope shape', () => {
  it('rejects a bare App ID URI, which yields an ID token the backend refuses', () => {
    const c: ResolvedRuntimeConfig = {
      ...resolveConfig(),
      authMode: 'msal',
      entraTenantId: 't',
      entraClientId: 'c',
      apiScope: 'api://x',
      authModeSource: 'runtime-config',
      invalidAuthMode: null,
    };
    expect(configProblems(c).some((p) => p.includes('App ID URI'))).toBe(true);
  });
});
