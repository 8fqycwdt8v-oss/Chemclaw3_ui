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
  entraAuthority: 'https://login.microsoftonline.com/',
  rawEntraAuthority: '',
  entraClientId: '',
  apiScope: '',
  appVersion: 'test',
  sseHeartbeatMs: 15_000,
  upstreamConnectTimeoutMs: 10_000,
  upstreamHeadersTimeoutMs: 120_000,
  requestTimeoutMs: 130_000,
  headersTimeoutMs: 30_000,
  maxConnections: 1_024,
  shutdownDrainMs: 10_000,
  maxUpstreamSockets: 512,
  maxUpstreamStreamSockets: 1_024,
  upstreamQueueTimeoutMs: 10_000,
  maxBodyBytes: 2 * 1024 * 1024,
  maxUploadBytes: 32 * 1024 * 1024,
  clientEventsRatePerMin: 3_000,
  warmSessions: true,
  reviewerRoles: [],
  maxMessageChars: 100_000,
  rawMaxMessageChars: '',
  maxMessageCharsIsValid: true,
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

/**
 * An upstream address with a path on it is an address this process cannot use.
 *
 * `server/proxy.ts` and `server/ready.ts` both take `protocol`/`hostname`/`port` off this URL and
 * never touch `pathname`; the path they send is built from the route table and starts at the
 * gateway root. So `https://gw.example/chemclaw` — the ordinary shape for a service behind a
 * shared ingress — boots clean, logs the address it was given, reports ready, and then asks the
 * gateway for `/jobs` when the service is at `/chemclaw/jobs`. Every `/api` route 404s, and the
 * one line that would explain it looks correct.
 *
 * Refused rather than honoured, which is the posture this file already takes for `AUTH_MODE` and
 * `MAX_MESSAGE_CHARS`: a prefix belongs in the ingress, and a half-honoured one is the same silent
 * 404 with more places to look for it.
 */
describe('a path prefix on CHEMCLAW_API_URL', () => {
  it('is refused, and the refusal names the path', () => {
    const problems = validateConfig(config({ apiUrl: 'https://gw.example/chemclaw' }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('/chemclaw');
    // And it names the address that would work, because the operator's next move is to write one.
    expect(problems[0]).toContain('https://gw.example');
  });

  it('is refused however deep it is, trailing slash included', () => {
    for (const url of [
      'http://svc:8080/api',
      'http://svc:8080/a/b/',
      'https://gw.example/chemclaw/',
    ]) {
      expect(validateConfig(config({ apiUrl: url }))).toHaveLength(1);
    }
  });

  it('leaves a bare origin alone, with or without the root slash', () => {
    for (const url of [
      'http://127.0.0.1:8080',
      'http://127.0.0.1:8080/',
      'http://chemclaw:8080',
      'https://chemclaw.example',
    ]) {
      expect(validateConfig(config({ apiUrl: url }))).toEqual([]);
    }
  });

  it('does not add a second complaint to a scheme that was already wrong', () => {
    // `ftp://example.com/x` is one misconfiguration, not two. The scheme is the thing to fix.
    const problems = validateConfig(config({ apiUrl: 'ftp://example.com/x' }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('must be http(s)');
  });

  it('is what the shipped default satisfies', async () => {
    vi.stubEnv('CHEMCLAW_API_URL', '');
    vi.resetModules();
    const fresh = await import('../server/config.ts');
    expect(fresh.validateConfig(fresh.cfg).filter((p) => p.includes('CHEMCLAW_API_URL'))).toEqual(
      [],
    );
  });
});

/**
 * A message cap that is not a cap is a configuration error, not a stricter setting.
 *
 * This used to be `Math.max(1, Math.floor(...))`, which turned `MAX_MESSAGE_CHARS=0` — the
 * widespread "0 means unlimited" convention, and what a Helm `| default 0` renders — into a
 * one-character composer, silently, for the whole deployment. Clamping *up* to 1 is the
 * destructive reading of a bad value, and it happened at the one layer that hid it from the SPA
 * guard written to catch it. The backend refuses the same value outright
 * (`service_max_message_chars: Field(default=100_000, gt=0)`), which is the posture mirrored here:
 * same shape as `rawAuthMode`/`authModeIsValid`, because a value nobody can serve is not a default.
 */
describe('an unusable MAX_MESSAGE_CHARS', () => {
  it('is refused rather than clamped to 1', async () => {
    for (const raw of ['0', '-5', '0.4', '1e-9', 'abc']) {
      vi.stubEnv('MAX_MESSAGE_CHARS', raw);
      vi.resetModules();
      const fresh = await import('../server/config.ts');

      expect(fresh.cfg.maxMessageCharsIsValid).toBe(false);
      // And the value it falls back to while refusing is the default, never 1: nothing downstream
      // may see a cap that refuses every message.
      expect(fresh.cfg.maxMessageChars).toBe(100_000);
      const problems = fresh.validateConfig(fresh.cfg);
      expect(problems.some((p) => p.includes('MAX_MESSAGE_CHARS') && p.includes(raw))).toBe(true);
    }
  });

  it('leaves a cap the deployment meant alone, unset included', async () => {
    for (const [raw, expected] of [
      ['250000', 250_000],
      ['', 100_000],
      ['  ', 100_000],
    ] as const) {
      vi.stubEnv('MAX_MESSAGE_CHARS', raw);
      vi.resetModules();
      const fresh = await import('../server/config.ts');

      expect(fresh.cfg.maxMessageCharsIsValid).toBe(true);
      expect(fresh.cfg.maxMessageChars).toBe(expected);
      // Only this field's verdict: `cfg` here is built from the real environment, whose default
      // bind is `0.0.0.0`, so the dev-auth exposure check legitimately fires alongside.
      expect(
        fresh.validateConfig(fresh.cfg).filter((p) => p.includes('MAX_MESSAGE_CHARS')),
      ).toEqual([]);
    }
  });

  it('names the value it was given, so the operator can find it', () => {
    const problems = validateConfig(
      config({ rawMaxMessageChars: '0', maxMessageCharsIsValid: false }),
    );
    expect(problems.join('\n')).toContain('"0"');
  });
});

/**
 * `ENTRA_AUTHORITY`: unset is the production default and changes nothing; set, it must be a URL
 * MSAL can use, because the alternative is a process that boots and a sign-in that fails in every
 * browser with an MSAL error code.
 */
describe('ENTRA_AUTHORITY', () => {
  const msal = {
    authMode: 'msal' as const,
    entraTenantId: 't',
    entraClientId: 'c',
    apiScope: 'a/b',
  };

  it('defaults to Entra public cloud for the tenant, exactly the string MSAL used to hardcode', async () => {
    vi.stubEnv('AUTH_MODE', 'msal');
    vi.stubEnv('ENTRA_TENANT_ID', 'tenant-guid');
    vi.resetModules();
    const fresh = await import('../server/config.ts');
    expect(fresh.cfg.entraAuthority).toBe('https://login.microsoftonline.com/tenant-guid');
    expect(fresh.cfg.rawEntraAuthority).toBe('');
  });

  it('is taken as given, without a trailing slash', async () => {
    vi.stubEnv('ENTRA_AUTHORITY', 'https://127.0.0.1:8443/entra/mock-tenant/');
    vi.resetModules();
    const fresh = await import('../server/config.ts');
    expect(fresh.cfg.entraAuthority).toBe('https://127.0.0.1:8443/entra/mock-tenant');
  });

  it('accepts an https authority on any host', () => {
    const raw = 'https://127.0.0.1:8443/entra/mock-tenant';
    expect(
      validateConfig(config({ ...msal, rawEntraAuthority: raw, entraAuthority: raw })),
    ).toEqual([]);
  });

  it.each(['http://127.0.0.1:8090/entra/mock-tenant', 'http://localhost/t'])(
    'refuses %s, loopback included: MSAL itself refuses a non-https authority',
    (raw) => {
      const problems = validateConfig(
        config({ ...msal, rawEntraAuthority: raw, entraAuthority: raw }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('ENTRA_AUTHORITY must be https');
      expect(problems[0]).toContain('authority_uri_insecure');
    },
  );

  it('is not relaxed by ALLOW_INSECURE_AUTH, which is about dev mode and nothing else', () => {
    const raw = 'http://127.0.0.1:8090/entra/mock-tenant';
    const problems = validateConfig(
      config({ ...msal, rawEntraAuthority: raw, entraAuthority: raw, allowInsecureAuth: true }),
    );
    expect(problems.some((p) => p.includes('ENTRA_AUTHORITY'))).toBe(true);
  });

  it.each([
    'not a url',
    'https://login.example/t?x=1',
    'https://login.example/t#frag',
    'https://*/t',
    'https://*.microsoftonline.com/t',
    'https://x;frame-ancestors/t',
  ])('refuses %s', (raw) => {
    const problems = validateConfig(
      config({ ...msal, rawEntraAuthority: raw, entraAuthority: raw }),
    );
    expect(problems.some((p) => p.includes('ENTRA_AUTHORITY'))).toBe(true);
  });
});
