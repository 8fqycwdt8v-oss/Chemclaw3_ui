/**
 * Boot the built server bundle the way the container does, and prove it serves.
 *
 * The gap this closes: `npm start` runs from the repo root, whose `package.json` carries
 * `"type": "module"`, and `start.sh` runs the TypeScript source rather than the bundle. So every
 * routine way of running this project loaded the server as ESM *because of a file the runtime
 * image does not contain* — the image copies `dist/` alone. Nothing exercised the artefact under
 * the conditions it actually runs in, which is why the output format was free to be wrong without
 * anyone noticing.
 *
 * This runs `dist/server.mjs` from a scratch directory containing only `dist/`, so there is no
 * `package.json` above it, exactly as in the image. Then it asks for a page.
 *
 * Deliberately not a container build: this has to run in CI and in a sandbox with no Docker
 * daemon, and the failure it guards against is about module resolution and the bundle's contents,
 * neither of which needs a container to reproduce.
 */

import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.SMOKE_PORT ?? 8791);
const BUNDLE = 'dist/server.mjs';

if (!existsSync(BUNDLE)) {
  console.error(`smoke-boot: ${BUNDLE} is missing — run \`npm run build\` first.`);
  process.exit(1);
}

const scratch = await mkdtemp(join(tmpdir(), 'chemclaw-boot-'));
let child;

const cleanup = async () => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  await rm(scratch, { recursive: true, force: true });
};

/**
 * Report a failure and stop — via `cleanup` explicitly, not via `finally`.
 *
 * `process.exit()` does not unwind, so a bare `process.exit(1)` inside the `try` below skips the
 * `finally` and leaves the spawned server holding the port. The next run then fails with
 * EADDRINUSE and blames the bundle for a mess this script made.
 */
const fail = async (...lines) => {
  for (const line of lines) console.error(line);
  await cleanup();
  process.exit(1);
};

try {
  // Only dist/ — no package.json, no node_modules. This is the whole point.
  await cp('dist', join(scratch, 'dist'), { recursive: true });

  child = spawn(process.execPath, ['dist/server.mjs'], {
    cwd: scratch,
    env: {
      ...process.env,
      PORT: String(PORT),
      // Loopback, so the unauthenticated-exposure refusal does not fire and this test is not
      // silently asserting the opt-out path instead of the boot path.
      BIND_HOST: '127.0.0.1',
      AUTH_MODE: 'dev',
      CLIENT_DIR: join(scratch, 'dist/client'),
      CHEMCLAW_API_URL: 'http://127.0.0.1:9',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));

  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const ready = (async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((r) => setTimeout(r, 250));
      if (child.exitCode !== null) return false;
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
        if (res.ok) return true;
      } catch {
        /* not listening yet */
      }
    }
    return false;
  })();

  const listening = await Promise.race([ready, exited.then(() => false)]);

  if (!listening) {
    await fail(
      'smoke-boot: FAILED — the bundle did not start and serve /healthz.',
      `exit code: ${child.exitCode}`,
      output.trim() || '(no output)',
    );
  }

  // The SPA must actually be served: a bundle that boots but whose CLIENT_DIR is wrong is a
  // container that answers its own health check and nothing else.
  const page = await fetch(`http://127.0.0.1:${PORT}/`);
  const html = await page.text();
  if (!page.ok || !html.includes('id="root"')) {
    await fail(`smoke-boot: FAILED — GET / returned ${page.status} without the SPA root.`);
  }
  if (!html.includes('/config.js')) {
    await fail(
      'smoke-boot: FAILED — index.html does not load /config.js, so the SPA would',
      'resolve no runtime configuration and refuse to start.',
    );
  }

  console.log(`smoke-boot: ok — ${BUNDLE} booted from a bare dist/ and served the SPA.`);
} finally {
  await cleanup();
}
