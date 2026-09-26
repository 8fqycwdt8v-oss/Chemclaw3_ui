// @vitest-environment node
//
// Node, not happy-dom: this asks the real BFF for real responses over a real socket, because the
// property under test is which header each response carries.

/**
 * `ISSUES.md` Issue 10: `'unsafe-eval'` for the RDKit worker, and for nothing else.
 *
 * A dedicated worker loaded from a network URL runs under its own response's CSP, not the
 * document's — measured in Chromium before this was built, and proved end to end by
 * `e2e/rdkit.spec.ts`, which draws a structure behind the real BFF. This file holds the server
 * half: exactly one path gets `RDKIT_WORKER_CSP`, every other response — the shell, a deep link,
 * another chunk, a look-alike, a missing worker, a revalidation — keeps the document's policy,
 * and the document's policy has no `'unsafe-eval'` in it.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

let bff: http.Server;
let port = 0;
let clientDir = '';
let documentCsp = '';
let workerCsp = '';
let isWorker: (pathname: string) => boolean = () => false;

const WORKER = '/assets/rdkit.worker-CYhqJjXL.js';

beforeAll(async () => {
  clientDir = mkdtempSync(path.join(tmpdir(), 'chemclaw-worker-csp-'));
  mkdirSync(path.join(clientDir, 'assets'));
  writeFileSync(path.join(clientDir, WORKER.slice(1)), 'export {};\n');
  writeFileSync(path.join(clientDir, 'assets', 'RDKit_minimal-DP2qLPJt.js'), 'export {};\n');
  writeFileSync(path.join(clientDir, 'assets', 'index-T4ny_sL-.js'), 'export {};\n');
  writeFileSync(path.join(clientDir, 'index.html'), '<!doctype html><title>x</title>');

  vi.resetModules();
  process.env.CLIENT_DIR = clientDir;
  process.env.CHEMCLAW_API_URL = 'http://127.0.0.1:1';
  const config = await import('../server/config.ts');
  documentCsp = config.cfg.csp;
  workerCsp = config.RDKIT_WORKER_CSP;
  isWorker = config.isRdkitWorkerScript;
  const { createBffServer } = await import('../server/app.ts');
  bff = createBffServer();
  await new Promise<void>((resolve) => bff.listen(0, '127.0.0.1', resolve));
  port = (bff.address() as AddressInfo).port;
});

afterAll(async () => {
  bff.closeAllConnections();
  await new Promise<void>((resolve) => bff.close(() => resolve()));
  rmSync(clientDir, { recursive: true, force: true });
});

async function get(
  urlPath: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; csp: string | null; type: string | null; etag: string | null }> {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, { headers });
  await res.arrayBuffer();
  return {
    status: res.status,
    csp: res.headers.get('content-security-policy'),
    type: res.headers.get('content-type'),
    etag: res.headers.get('etag'),
  };
}

const directive = (policy: string, name: string): string[] =>
  policy
    .split(';')
    .map((d) => d.trim().split(/\s+/))
    .find(([key]) => key === name)
    ?.slice(1) ?? [];

describe('the two policies', () => {
  it('keeps eval out of the document', () => {
    expect(directive(documentCsp, 'script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(documentCsp).not.toContain("'unsafe-eval'");
  });

  it('gives the worker what RDKit measured as needing, and closes everything else', () => {
    // Measured behind the real BFF: with `'wasm-unsafe-eval'` alone the worker's load throws
    // `EvalError` in Embind and nothing is drawn; with `'unsafe-eval'` added it draws.
    expect(directive(workerCsp, 'script-src')).toEqual([
      "'self'",
      "'wasm-unsafe-eval'",
      "'unsafe-eval'",
    ]);
    expect(directive(workerCsp, 'default-src')).toEqual(["'none'"]);
    expect(directive(workerCsp, 'connect-src')).toEqual(["'self'"]);
    expect(directive(workerCsp, 'base-uri')).toEqual(["'none'"]);
    // No inline script anywhere, worker included.
    expect(workerCsp).not.toContain("'unsafe-inline'");
  });
});

describe('which responses carry which', () => {
  it('sends the worker policy on the RDKit worker script', async () => {
    const res = await get(WORKER);
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/javascript/);
    expect(res.csp).toBe(workerCsp);
  });

  it('sends it on a revalidation too, whose headers replace the cached ones', async () => {
    // `sirv` answers a matching `If-None-Match` with a 304 before any per-file hook runs, and a
    // 304's headers update the cached response's. If this carried the document's policy, a
    // reload would bring the worker back from cache unable to load RDKit.
    const { etag } = await get(WORKER);
    expect(etag).toBeTruthy();
    const res = await get(WORKER, { 'if-none-match': etag! });
    expect(res.status).toBe(304);
    expect(res.csp).toBe(workerCsp);
  });

  it.each([
    ['the shell', '/'],
    ['a deep link, which is the shell', '/c/abc'],
    ['the entry chunk', '/assets/index-T4ny_sL-.js'],
    ['the RDKit loader chunk the worker imports', '/assets/RDKit_minimal-DP2qLPJt.js'],
    ['the runtime config', '/config.js'],
  ])('sends the document policy on %s', async (_what, urlPath) => {
    expect((await get(urlPath)).csp).toBe(documentCsp);
  });

  it.each([
    ['a worker name with a suffix', '/assets/rdkit.worker-CYhqJjXL.js.map'],
    ['a worker name outside /assets/', '/rdkit.worker-CYhqJjXL.js'],
    ['a worker name one directory down', '/assets/x/rdkit.worker-CYhqJjXL.js'],
    ['a worker name with no hash', '/assets/rdkit.worker.js'],
    ['a look-alike name', '/assets/evil-rdkit.worker-CYhqJjXL.js'],
  ])('refuses the relaxation to %s', async (_what, urlPath) => {
    expect(isWorker(urlPath)).toBe(false);
    expect((await get(urlPath)).csp).toBe(documentCsp);
  });

  it('never sends the relaxed policy with HTML', async () => {
    // A worker-shaped path that does not exist is a plain-text 404: it carries an extension, so
    // `sirv` never falls back to `index.html` for it — the one way the relaxed policy could have
    // arrived on a document.
    const res = await get('/assets/rdkit.worker-AAAAAAAA.js');
    expect(res.status).toBe(404);
    expect(res.type ?? '').not.toMatch(/html/);
  });
});
