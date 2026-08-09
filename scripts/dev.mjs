/**
 * Development launcher: starts the BFF and the Vite dev server, pointed at a REAL Chemclaw
 * service.
 *
 * There is no mock backend in this project by design — the frontend and the FastAPI service are
 * developed and tested against each other. Set CHEMCLAW_API_URL to wherever yours is running:
 *
 *   uvicorn service.app:create_app --factory --port 8080     (in the Chemclaw3 repo)
 *   npm run dev                                              (here)
 *
 * or bring both up together with `docker compose up`.
 */

import { spawn } from 'node:child_process';

const BFF_PORT = process.env.BFF_PORT ?? '8787';
const API_URL = process.env.CHEMCLAW_API_URL ?? 'http://127.0.0.1:8080';

console.log(`\n  Chemclaw3 UI — development`);
console.log(`  BFF        http://127.0.0.1:${BFF_PORT}`);
console.log(`  UI         http://127.0.0.1:5173`);
console.log(`  backend    ${API_URL}\n`);

const children = [];

const start = (name, command, args, env) => {
  const child = spawn(command, args, {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, ...env },
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`\n  ${name} exited with code ${code}`);
      shutdown(code);
    }
  });
  children.push(child);
  return child;
};

const shutdown = (code = 0) => {
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
};

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// Node strips TypeScript types natively, so the BFF runs from source with no build step.
//
// `--experimental-strip-types` is passed explicitly even though it is unflagged from 22.18: this
// package declares `node >=22.6` (package.json), and on 22.6–22.17 the flag is required — without
// it `npm run dev` simply failed to start the BFF on a version the project claims to support.
// The flag is accepted (as a no-op) on newer versions, so passing it costs nothing.
start('bff', process.execPath, ['--experimental-strip-types', '--watch', 'server/index.ts'], {
  PORT: BFF_PORT,
  BIND_HOST: '127.0.0.1',
  CHEMCLAW_API_URL: API_URL,
  // The dev server serves the client; the BFF only proxies and serves /config.js.
  CLIENT_DIR: 'dist/client',
  // Loopback bind, so the unauthenticated-exposure refusal does not apply.
  AUTH_MODE: process.env.AUTH_MODE ?? 'dev',
});

start('vite', process.execPath, ['node_modules/vite/bin/vite.js'], { BFF_PORT });
