// @vitest-environment node
/**
 * `validateConfig` refusing a configuration that cannot work.
 *
 * The default `PORT` and the default `CHEMCLAW_API_URL` port were both 8080, so a bare
 * `docker run` with neither set produced a BFF that proxied `/api` to its own listener. It passed
 * its own healthcheck, and `POST /api/sessions` came back as `index.html` — a failure that looks
 * like a broken backend from every angle except this one, and one nothing in the process reported.
 *
 * Only loopback counts. `docker-compose.yml` points the UI at `http://chemclaw:8080`, which is a
 * different host on the same port and entirely legitimate; refusing that would break the
 * documented quickstart.
 */

import { describe, expect, it, vi } from 'vitest';

async function validate(env: Record<string, string>): Promise<string[]> {
  for (const k of ['PORT', 'CHEMCLAW_API_URL', 'AUTH_MODE']) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  const { validateConfig } = await import('../server/config.ts');
  return validateConfig();
}

const selfProxy = (problems: string[]) =>
  problems.filter((p) => p.includes("this server's own port"));

describe('proxying to ourselves', () => {
  it('is refused when the upstream is loopback on our own port', async () => {
    expect(
      selfProxy(await validate({ PORT: '8080', CHEMCLAW_API_URL: 'http://127.0.0.1:8080' })),
    ).toHaveLength(1);
  });

  it('is refused for localhost and ::1 too', async () => {
    for (const host of ['localhost', '[::1]']) {
      expect(
        selfProxy(await validate({ PORT: '9000', CHEMCLAW_API_URL: `http://${host}:9000` })),
        host,
      ).toHaveLength(1);
    }
  });

  it('allows a different host on the same port, which is what compose does', async () => {
    expect(
      selfProxy(await validate({ PORT: '8080', CHEMCLAW_API_URL: 'http://chemclaw:8080' })),
    ).toHaveLength(0);
  });

  it('allows the same host on a different port', async () => {
    expect(
      selfProxy(await validate({ PORT: '8787', CHEMCLAW_API_URL: 'http://127.0.0.1:8080' })),
    ).toHaveLength(0);
  });
});
