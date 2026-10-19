// @vitest-environment node

/**
 * `npm run check:live-contract`, driven against a stand-in service.
 *
 * It exists to report drift between what a deployment serves and what this UI is pinned to, so
 * each way that can go is built here and must be refused: a newer version, the same version with a
 * different surface, a service that cannot be read. The two that are not failures — a served
 * contract equal to the pin, and nothing configured — must not be.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

type Doc = {
  info: { version: string };
  paths: Record<string, unknown>;
  components: { schemas: Record<string, unknown> };
};
const pinned = JSON.parse(readFileSync('contracts/core-openapi.json', 'utf8')) as Doc;

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

async function serve(status: number, body: unknown): Promise<string> {
  server = createServer((req, res) => {
    res.writeHead(req.url === '/openapi.json' ? status : 404, {
      'content-type': 'application/json',
    });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
}

/** An async spawn: the stand-in server lives in this process, so the child cannot block it. */
function run(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ status: number | null; out: string }>((done) => {
    const child = spawn(process.execPath, ['scripts/check-live-contract.mjs', ...args], {
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('close', (status) => done({ status, out }));
  });
}

describe('check:live-contract', { timeout: 30_000 }, () => {
  it('passes when the service serves the pinned contract, key order aside', async () => {
    const reordered = Object.fromEntries(Object.entries(pinned).reverse());
    const result = await run([await serve(200, reordered)]);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('serves the pinned contract');
  });

  it('reads the service from CHEMCLAW_API_URL when no argument is given', async () => {
    const result = await run([], { CHEMCLAW_API_URL: await serve(200, pinned) });
    expect(result.status, result.out).toBe(0);
  });

  it('fails on a different version, naming both', async () => {
    const result = await run([await serve(200, { ...pinned, info: { version: '9.9.9' } })]);
    expect(result.status).toBe(1);
    expect(result.out).toContain(`pinned ${pinned.info.version}, served 9.9.9`);
  });

  it('fails on the same version with a different surface, naming the route', async () => {
    const { '/profiles': _dropped, ...paths } = pinned.paths;
    const result = await run([await serve(200, { ...pinned, paths })]);
    expect(result.status).toBe(1);
    expect(result.out).toContain('routes pinned and not served: /profiles');
  });

  it('fails when the service answers an error or nothing', async () => {
    expect((await run([await serve(503, { detail: 'down' })])).status).toBe(1);
    const down = await run(['http://127.0.0.1:1']);
    expect(down.status).toBe(1);
    expect(down.out).toContain('could not read the served contract');
  });

  it('skips out loud, and exits 0, when no service is configured', async () => {
    const result = await run([]);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('SKIPPED — no service configured');
  });
});
