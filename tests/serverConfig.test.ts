/**
 * `validateConfig` — the BFF's boot gate.
 *
 * The case this file exists for is the unauthenticated-exposure refusal. It used to be a
 * `log.warn` fired from inside the `server.listen` callback, i.e. after the socket was already
 * accepting connections, and the backend's own comment on the equivalent check names why that is
 * not good enough: "the earlier warn-and-boot was one missed log line from an open deployment".
 */

import { describe, expect, it } from 'vitest';
import { isLoopbackHost, validateConfig, type BffConfig } from '../server/config.ts';

const base: BffConfig = {
  port: 8080,
  bindHost: '127.0.0.1',
  clientDir: '/app/dist/client',
  apiUrl: 'http://127.0.0.1:8080',
  authMode: 'dev',
  entraTenantId: '',
  entraClientId: '',
  apiScope: '',
  appVersion: 'test',
  sseHeartbeatMs: 15_000,
  upstreamConnectTimeoutMs: 10_000,
  maxBodyBytes: 4_000_000,
  allowInsecure: false,
  rawAuthMode: 'dev',
  authModeIsValid: true,
  csp: '',
  logLevel: 'info',
};

const cfg = (over: Partial<BffConfig>): BffConfig => ({ ...base, ...over });
const joined = (c: BffConfig): string => validateConfig(c).join('\n');

describe('unauthenticated exposure', () => {
  it('refuses dev auth on a non-loopback bind', () => {
    const problems = validateConfig(cfg({ bindHost: '0.0.0.0' }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/SECURITY/);
    expect(problems[0]).toMatch(/ALLOW_INSECURE_AUTH/);
  });

  it('allows it with the explicit opt-out', () => {
    expect(validateConfig(cfg({ bindHost: '0.0.0.0', allowInsecure: true }))).toEqual([]);
  });

  it.each(['127.0.0.1', 'localhost', '::1', '[::1]'])('permits dev auth on %s', (host) => {
    expect(validateConfig(cfg({ bindHost: host }))).toEqual([]);
  });

  it('does not fire for msal, which is authenticated whatever it binds', () => {
    const c = cfg({
      bindHost: '0.0.0.0',
      authMode: 'msal',
      rawAuthMode: 'msal',
      entraTenantId: 't',
      entraClientId: 'c',
      apiScope: 'api://x/y',
    });
    expect(validateConfig(c)).toEqual([]);
  });
});

describe('AUTH_MODE parsing', () => {
  it('refuses a value that names no mode rather than falling back to dev', () => {
    // The whole point: `AUTH_MODE=MSAL` used to resolve to 'dev' — one capitalisation away from
    // an unauthenticated production deployment with frame-ancestors *.
    const problems = validateConfig(cfg({ rawAuthMode: 'MSAL', authModeIsValid: false }));
    expect(joined(cfg({ rawAuthMode: 'MSAL', authModeIsValid: false }))).toMatch(/not a valid mode/);
    expect(problems.some((p) => p.includes('"MSAL"'))).toBe(true);
  });

  it('accepts the two real modes', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
  });
});

describe('msal completeness', () => {
  it('requires tenant, client id and scope', () => {
    const problems = validateConfig(cfg({ authMode: 'msal', rawAuthMode: 'msal' }));
    expect(problems).toHaveLength(3);
  });
});

describe('numeric ranges', () => {
  it('rejects a negative heartbeat, which setInterval would clamp to a 1ms write loop', () => {
    expect(joined(cfg({ sseHeartbeatMs: -1 }))).toMatch(/SSE_HEARTBEAT_MS/);
  });

  it('accepts a zero heartbeat, which means disabled', () => {
    expect(validateConfig(cfg({ sseHeartbeatMs: 0 }))).toEqual([]);
  });

  it('rejects an out-of-range port', () => {
    expect(joined(cfg({ port: 0 }))).toMatch(/PORT/);
    expect(joined(cfg({ port: 70_000 }))).toMatch(/PORT/);
  });

  it('rejects a non-positive body cap', () => {
    expect(joined(cfg({ maxBodyBytes: 0 }))).toMatch(/MAX_BODY_BYTES/);
  });
});

describe('upstream url', () => {
  it('rejects a non-http scheme', () => {
    expect(joined(cfg({ apiUrl: 'ftp://x/' }))).toMatch(/must be http/);
  });

  it('rejects an unparseable url', () => {
    expect(joined(cfg({ apiUrl: 'not a url' }))).toMatch(/not a valid URL/);
  });
});
