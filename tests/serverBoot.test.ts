// @vitest-environment node
/**
 * Booting the BFF without a built client, and what it caches.
 *
 * Both of these are about the server's promises to itself. It warns that missing static assets
 * "will 404" — but `sirv` reads the tree eagerly and threw ENOENT one line later, so a fresh clone
 * running `npm run dev` got a dead process and a stack trace instead of the degraded server the
 * warning describes. And `index.html` "must never be cached or a deploy won't take" — but the
 * guard tested the *request* path, so every client route, which is every URL a user actually
 * reloads, was served the shell with no `Cache-Control` at all.
 *
 * Spawned as a real process because that is the only way to exercise a module whose side effects
 * are `listen()` and `process.exit()`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const children: ChildProcess[] = [];

afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
});

/** Start the built server and resolve once it answers, or reject if it dies first. */
async function boot(env: Record<string, string>, port: number): Promise<void> {
  const child = spawn('node', ['dist/server.js'], {
    cwd: '/home/user/Chemclaw3_ui',
    env: { ...process.env, PORT: String(port), AUTH_MODE: 'dev', ...env },
    stdio: 'ignore',
  });
  children.push(child);

  const deadline = Date.now() + 8000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      await fetch(`http://127.0.0.1:${port}/healthz`);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error('server never answered');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

describe('a missing client directory', () => {
  it('degrades to 404s instead of killing the process', async () => {
    // Exactly the fresh-clone case: the BFF starts before anything has been built.
    await boot({ CLIENT_DIR: join(tmpdir(), 'chemclaw-does-not-exist') }, 8931);

    const health = await fetch('http://127.0.0.1:8931/healthz');
    expect(health.status).toBe(200);

    const asset = await fetch('http://127.0.0.1:8931/assets/app.js');
    expect(asset.status).toBe(404);
  });
});

describe('cache-control on the shell', () => {
  it('is set on client routes, not just on /', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chemclaw-client-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    await boot({ CLIENT_DIR: dir }, 8932);

    // `/c/:id` is what a user reloads or has bookmarked, and it is served the shell.
    for (const path of ['/', '/c/abc', '/s/' + 'a'.repeat(32)]) {
      const res = await fetch(`http://127.0.0.1:8932${path}`);
      expect(res.headers.get('cache-control'), `for ${path}`).toBe('no-cache');
    }

    // A hashed asset is immutable and must NOT pick up the shell's no-cache.
    const asset = await fetch('http://127.0.0.1:8932/assets/app-abc123.js');
    expect(asset.headers.get('cache-control')).not.toBe('no-cache');
  });
});
