// @vitest-environment node
//
// Node, not happy-dom: this asks the real static handler for real bytes over a real socket, which
// is the only place either of these defects was visible.

/**
 * What the browser is actually sent for a static asset.
 *
 * Two claims sat in `server/app.ts` for the life of the file and neither was true of a response:
 *
 *  - "Serve Vite's precompressed output rather than compressing at request time", above
 *    `gzip: true, brotli: true`. Those options do not compress; they serve a pre-built `.gz`/`.br`
 *    sibling if one exists and fall through in silence if not, and the build wrote none. Measured
 *    on the shipped build with `Accept-Encoding: gzip, br` sent: `Content-Length: 634903` and no
 *    `Content-Encoding` at all, against 194,190 B gzipped — 3.27x, on every cold load, times 200.
 *  - "Hashed assets are immutable", above a `setHeaders` that set `cache-control` for the HTML
 *    shell and **nothing** for anything else. `sirv` emits no `Cache-Control` without a `maxAge`,
 *    so a hashed asset arrived with an ETag, a fresh `Last-Modified` and no freshness at all,
 *    which means a conditional GET for every asset on every load into the same single-threaded
 *    process that is piping the SSE streams.
 *
 * A test could not have caught either from the outside before, because both are *response
 * headers* and every static-serving test in this suite asserted a status and a body. This one
 * reads the headers, and it builds its own fixture directory so it is a statement about the
 * handler rather than about whatever happens to be in `dist/`.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

let bff: http.Server;
let port = 0;
let clientDir = '';

/** Big enough to be worth compressing and compressible enough to prove it happened. */
const BUNDLE = `${'export const answer = "chemclaw";\n'.repeat(400)}`;

beforeAll(async () => {
  clientDir = mkdtempSync(path.join(tmpdir(), 'chemclaw-assets-'));
  mkdirSync(path.join(clientDir, 'assets'));
  // A hashed build output, an unhashed file copied from `public/`, and the shell — the three cache
  // policies this handler has to tell apart.
  writeFileSync(path.join(clientDir, 'assets', 'index-T4ny_sL-.js'), BUNDLE);
  writeFileSync(path.join(clientDir, 'theme-boot.js'), BUNDLE);
  writeFileSync(path.join(clientDir, 'index.html'), '<!doctype html><title>x</title>');

  // The real build step, not a hand-written sidecar: what is under test is that `npm run build`
  // produces what `sirv` was already configured to look for.
  execFileSync(process.execPath, ['scripts/compress-assets.mjs', clientDir], { stdio: 'pipe' });

  vi.resetModules();
  process.env.CLIENT_DIR = clientDir;
  process.env.CHEMCLAW_API_URL = 'http://127.0.0.1:1';
  const { createBffServer } = await import('../server/app.ts');
  bff = createBffServer();
  await new Promise<void>((resolve) => bff.listen(0, '127.0.0.1', resolve));
  port = (bff.address() as AddressInfo).port;
});

afterAll(async () => {
  // `fetch` keeps its connections alive and `close()` waits for them, so without this the hook
  // hangs until vitest kills it — the requests above all succeeded, and the file still failed.
  bff.closeAllConnections();
  await new Promise<void>((resolve) => bff.close(() => resolve()));
  rmSync(clientDir, { recursive: true, force: true });
});

/** One request, reporting only what this file is about. */
async function get(
  urlPath: string,
  encoding = 'gzip, br',
): Promise<{
  status: number;
  bytes: number;
  encoding: string | null;
  cacheControl: string | null;
}> {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    headers: { 'accept-encoding': encoding },
  });
  const body = await res.arrayBuffer();
  return {
    status: res.status,
    // `fetch` decodes a compressed body, so the wire size is the header rather than the length of
    // what we were handed — which is the whole distinction this test exists to make.
    bytes: Number(res.headers.get('content-length') ?? body.byteLength),
    encoding: res.headers.get('content-encoding'),
    cacheControl: res.headers.get('cache-control'),
  };
}

describe('a hashed asset', () => {
  it('is served compressed when the browser asks for it', async () => {
    const compressed = await get('/assets/index-T4ny_sL-.js');
    const raw = await get('/assets/index-T4ny_sL-.js', 'identity');

    expect(compressed.status).toBe(200);
    // Before: no `content-encoding` at all, and `bytes` equal to `raw.bytes`.
    expect(compressed.encoding).toBe('br');
    expect(compressed.bytes).toBeLessThan(raw.bytes / 3);
    expect(raw.encoding).toBeNull();
  });

  it('falls back to gzip for a browser that cannot take brotli', async () => {
    const gz = await get('/assets/index-T4ny_sL-.js', 'gzip');
    expect(gz.encoding).toBe('gzip');
    expect(gz.bytes).toBeLessThan(BUNDLE.length / 3);
  });

  it('is cacheable for ever, which is what its URL already promised', async () => {
    // Before: `null`. The comment said immutable; the response said nothing.
    expect((await get('/assets/index-T4ny_sL-.js')).cacheControl).toBe(
      'public, max-age=31536000, immutable',
    );
  });
});

describe('a file whose URL does not change when its bytes do', () => {
  it('revalidates rather than being frozen for a year', async () => {
    // `theme-boot.js` and `favicon.svg` are copied from `public/` under a stable name, so caching
    // one immutably would mean a year to change it.
    expect((await get('/theme-boot.js')).cacheControl).toBe('no-cache');
  });

  it('still gets the compression, which is orthogonal to the caching', async () => {
    expect((await get('/theme-boot.js')).encoding).toBe('br');
  });
});

describe('the HTML shell', () => {
  it('is never cached, at the root or down a client deep link', async () => {
    expect((await get('/')).cacheControl).toBe('no-cache');
    // Served by the SPA fallback, which is the case a previous version of this check missed.
    expect((await get('/c/abc123')).cacheControl).toBe('no-cache');
  });
});
