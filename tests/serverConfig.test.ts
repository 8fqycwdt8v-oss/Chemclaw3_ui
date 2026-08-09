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
  entraClientSecret: '',
  apiScope: '',
  sessionSecret: '',
  publicOrigin: '',
  entraAuthorityHost: 'https://login.microsoftonline.com',
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

  it('does not fire for msal-spa, which is authenticated whatever it binds', () => {
    const c = cfg({
      bindHost: '0.0.0.0',
      authMode: 'msal-spa',
      rawAuthMode: 'msal-spa',
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
    expect(joined(cfg({ rawAuthMode: 'MSAL', authModeIsValid: false }))).toMatch(
      /not a valid mode/,
    );
    expect(problems.some((p) => p.includes('"MSAL"'))).toBe(true);
  });

  it('accepts the two real modes', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
  });
});

describe('msal-spa completeness', () => {
  it('requires tenant, client id and scope', () => {
    const problems = validateConfig(cfg({ authMode: 'msal-spa', rawAuthMode: 'msal-spa' }));
    expect(problems).toHaveLength(3);
  });

  it('needs no client or session secret — the browser holds the token in that mode', () => {
    const c = cfg({
      authMode: 'msal-spa',
      rawAuthMode: 'msal-spa',
      entraTenantId: 't',
      entraClientId: 'c',
      apiScope: 'api://x/y',
    });
    expect(validateConfig(c)).toEqual([]);
  });
});

describe('bff completeness', () => {
  const bff = (over: Partial<BffConfig> = {}): BffConfig =>
    cfg({
      authMode: 'bff',
      rawAuthMode: 'bff',
      entraTenantId: 't',
      entraClientId: 'c',
      apiScope: 'api://x/y',
      entraClientSecret: 'a-secret',
      sessionSecret: 'a-session-secret-of-at-least-32-chars',
      ...over,
    });

  it('accepts a complete configuration', () => {
    expect(validateConfig(bff())).toEqual([]);
  });

  it('requires a client secret, because this is a confidential client', () => {
    expect(joined(bff({ entraClientSecret: '' }))).toMatch(/ENTRA_CLIENT_SECRET/);
  });

  it('requires a session secret and refuses a short one', () => {
    expect(joined(bff({ sessionSecret: '' }))).toMatch(/SESSION_SECRET is required/);
    // A guessable key means anyone can forge a session for any user, so the seal must not be
    // allowed to become decorative.
    expect(joined(bff({ sessionSecret: 'changeme' }))).toMatch(/too short/);
  });

  it('names msal-spa when an AUTH_MODE=msal deployment lands here unchanged', () => {
    // This is the whole migration story. An existing deployment sets nothing new, fails to boot,
    // and the refusal has to be enough to choose between adopting BFF custody and staying put.
    const problems = joined(bff({ rawAuthMode: 'msal', entraClientSecret: '', sessionSecret: '' }));
    expect(problems).toMatch(/AUTH_MODE=msal now resolves to BFF token custody/);
    expect(problems).toMatch(/AUTH_MODE=msal-spa/);
  });

  it('does not mention msal-spa for a deployment that asked for bff by name', () => {
    // Someone who wrote `AUTH_MODE=bff` chose it; suggesting they revert is noise.
    expect(joined(bff({ entraClientSecret: '' }))).not.toMatch(/msal-spa/);
  });

  it('refuses a plain-HTTP identity provider that is not loopback', () => {
    // The client secret and the authorization code both cross that connection.
    expect(joined(bff({ entraAuthorityHost: 'http://login.evil.test' }))).toMatch(
      /ENTRA_AUTHORITY_HOST must be https/,
    );
    // Loopback is exempt, which is what lets the flow be exercised against a mock provider.
    expect(validateConfig(bff({ entraAuthorityHost: 'http://127.0.0.1:8792' }))).toEqual([]);
  });

  it('accepts a sovereign-cloud authority', () => {
    expect(validateConfig(bff({ entraAuthorityHost: 'https://login.microsoftonline.us' }))).toEqual(
      [],
    );
  });

  it('refuses a PUBLIC_ORIGIN with a path, which Entra compares literally', () => {
    expect(joined(bff({ publicOrigin: 'https://x.test/app' }))).toMatch(/PUBLIC_ORIGIN/);
    // Unset is permitted — it falls back to the Host header, and is warned about at boot rather
    // than blocking local development.
    expect(validateConfig(bff({ publicOrigin: '' }))).toEqual([]);
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
