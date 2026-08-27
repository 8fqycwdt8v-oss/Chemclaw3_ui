/**
 * The BFF refuses to serve an unauthenticated deployment it was not told to serve.
 *
 * `server/config.ts` had no test at all, and two of the things it got wrong are only visible from
 * one: a mode string it did not recognise resolved to `dev` — the unauthenticated mode — and the
 * "mirrors the backend's fail-closed posture" comment sat above a function that only ever logged.
 *
 * `validateConfig` takes an explicit config precisely so this is testable: `cfg` itself is built
 * from `process.env` at module scope and there is only ever one of it per process.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLoopbackHost, validateConfig, type BffConfig } from '../server/config.ts';

/** A configuration with nothing wrong with it. Each test breaks exactly one thing. */
const base: BffConfig = {
  port: 8080,
  bindHost: '127.0.0.1',
  clientDir: 'dist/client',
  apiUrl: 'http://127.0.0.1:8000',
  authMode: 'dev',
  rawAuthMode: 'dev',
  authModeIsValid: true,
  allowInsecureAuth: false,
  allowFraming: false,
  entraTenantId: '',
  entraClientId: '',
  apiScope: '',
  appVersion: 'test',
  sseHeartbeatMs: 15_000,
  upstreamConnectTimeoutMs: 10_000,
  requestTimeoutMs: 130_000,
  maxUpstreamSockets: 512,
  maxBodyBytes: 2 * 1024 * 1024,
  maxUploadBytes: 32 * 1024 * 1024,
  warmSessions: true,
  reviewerRoles: [],
  maxMessageChars: 100_000,
  csp: '',
  logLevel: 'error',
  clientLogLevel: 'info',
};

const config = (over: Partial<BffConfig> = {}): BffConfig => ({ ...base, ...over });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('an unrecognised AUTH_MODE', () => {
  it('is refused rather than treated as dev', async () => {
    // The whole bug in one line: `AUTH_MODE=MSAL` used to boot with no sign-in required.
    vi.stubEnv('AUTH_MODE', 'MSAL');
    vi.resetModules();
    const fresh = await import('../server/config.ts');

    expect(fresh.cfg.authModeIsValid).toBe(false);
    const problems = fresh.validateConfig(fresh.cfg);
    expect(problems.some((p) => p.includes('AUTH_MODE') && p.includes('MSAL'))).toBe(true);
  });

  it('names the value it was given, so the typo is findable', () => {
    const problems = validateConfig(config({ rawAuthMode: 'entra', authModeIsValid: false }));
    expect(problems.join('\n')).toContain('"entra"');
  });

  it('reports the mode alone, not a second complaint about dev', () => {
    // A typo resolves to `dev` internally. Reporting the exposure too would send the reader
    // looking for a dev-mode misconfiguration they never made.
    const problems = validateConfig(
      config({ rawAuthMode: 'entra', authModeIsValid: false, bindHost: '0.0.0.0' }),
    );
    expect(problems).toHaveLength(1);
  });

  it('accepts the two real modes', async () => {
    for (const mode of ['dev', 'msal']) {
      vi.stubEnv('AUTH_MODE', mode);
      vi.resetModules();
      const fresh = await import('../server/config.ts');
      expect(fresh.cfg.authModeIsValid).toBe(true);
      expect(fresh.cfg.authMode).toBe(mode);
    }
  });

  it('an unset AUTH_MODE is still dev, and still valid', async () => {
    vi.stubEnv('AUTH_MODE', '');
    vi.resetModules();
    const fresh = await import('../server/config.ts');
    expect(fresh.cfg.authMode).toBe('dev');
    expect(fresh.cfg.authModeIsValid).toBe(true);
  });
});

describe('dev auth on a reachable bind', () => {
  it('is refused', () => {
    const problems = validateConfig(config({ bindHost: '0.0.0.0' }));
    expect(problems.some((p) => p.includes('ALLOW_INSECURE_AUTH'))).toBe(true);
  });

  it('is allowed when declared', () => {
    expect(validateConfig(config({ bindHost: '0.0.0.0', allowInsecureAuth: true }))).toEqual([]);
  });

  it('is fine on loopback without any opt-out', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
      expect(validateConfig(config({ bindHost: host }))).toEqual([]);
    }
  });

  it('does not fire for an authenticated mode on the same bind', () => {
    const problems = validateConfig(
      config({
        authMode: 'msal',
        rawAuthMode: 'msal',
        bindHost: '0.0.0.0',
        entraTenantId: 't',
        entraClientId: 'c',
        apiScope: 's',
      }),
    );
    expect(problems).toEqual([]);
  });
});

describe('isLoopbackHost', () => {
  it('covers IPv6 loopback, which the old inline check did not', () => {
    // The check this replaces was `bindHost !== '127.0.0.1' && bindHost !== 'localhost'`, so a
    // container binding `::1` was reported as a public exposure it was not.
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
  });

  it('tolerates the whitespace an env var arrives with', () => {
    expect(isLoopbackHost(' 127.0.0.1 ')).toBe(true);
  });

  it('is not fooled by a host that merely starts with one', () => {
    expect(isLoopbackHost('127.0.0.1.example.com')).toBe(false);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
  });
});

describe('the checks that were already there still work', () => {
  it('rejects a non-http upstream', () => {
    const problems = validateConfig(config({ apiUrl: 'ftp://example.com' }));
    expect(problems.some((p) => p.includes('CHEMCLAW_API_URL must be http(s)'))).toBe(true);
  });

  it('requires the Entra settings under msal', () => {
    const problems = validateConfig(config({ authMode: 'msal', rawAuthMode: 'msal' }));
    expect(problems).toHaveLength(3);
  });
});
