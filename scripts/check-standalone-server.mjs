/**
 * The server bundle runs with no `node_modules` anywhere above it.
 *
 *   node scripts/check-standalone-server.mjs
 *
 * The container's runtime stage copies `dist/` and nothing else — esbuild is expected to have
 * inlined `sirv`. Anything it failed to inline would surface only as a crash on deploy, so this
 * proves it here: `dist/` is copied into a temp directory (a copy rather than deleting
 * `node_modules` in place, so the check stays order-independent), the bundle is started from
 * there, and `/healthz` must answer.
 *
 * Was inline shell in `.github/workflows/ci.yml`. The one behavioural difference from that version
 * is that this one reports *why* it failed — the old `curl | grep` swallowed the server's own
 * stderr, so "did not answer /healthz" was the whole diagnosis.
 */

import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.STANDALONE_PORT ?? 8788);

const workdir = mkdtempSync(join(tmpdir(), 'chemclaw-ui-standalone-'));
try {
  cpSync('dist', join(workdir, 'dist'), { recursive: true });
} catch (err) {
  console.error('check-standalone-server: cannot copy dist/ — run `npm run build` first.');
  console.error(String(err));
  rmSync(workdir, { recursive: true, force: true });
  process.exit(1);
}

console.log(`\nStandalone server bundle, from ${workdir}\n`);

const server = spawn(process.execPath, ['dist/server.js'], {
  cwd: workdir,
  env: {
    ...process.env,
    PORT: String(PORT),
    BIND_HOST: '127.0.0.1',
    CLIENT_DIR: 'dist/client',
    // Deliberately a port nothing listens on: this check is about the bundle starting, not about
    // reaching a backend, and `/healthz` is liveness rather than readiness.
    CHEMCLAW_API_URL: 'http://127.0.0.1:9',
    LOG_LEVEL: 'error',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
server.stdout.on('data', (chunk) => (output += chunk));
server.stderr.on('data', (chunk) => (output += chunk));

const stop = () => {
  server.kill('SIGKILL');
  rmSync(workdir, { recursive: true, force: true });
};

const fail = (why) => {
  console.error(`  ✗ ${why}`);
  if (output.trim()) console.error(`\n  the bundle said:\n${output.replace(/^/gm, '    ')}`);
  stop();
  process.exit(1);
};

let exited = null;
server.on('exit', (code, signal) => (exited = signal ? `signal ${signal}` : `exit code ${code}`));

for (let attempt = 0; attempt < 40; attempt += 1) {
  if (exited !== null) fail(`the bundle stopped before it served anything (${exited})`);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    const body = await res.text();
    if (res.ok && body.includes('"ok"')) {
      console.log(`  ✓ dist/server.js serves /healthz with no node_modules — ${body.trim()}\n`);
      stop();
      process.exit(0);
    }
    fail(`/healthz answered ${res.status}: ${body.trim()}`);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

fail('/healthz did not answer within 10s');
