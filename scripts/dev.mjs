/**
 * Development launcher: starts the BFF and the Vite dev server, pointed at a REAL Chemclaw
 * service.
 *
 * There is no mock backend in this project by design — the frontend and the FastAPI service are
 * developed and tested against each other. Set CHEMCLAW_API_URL to wherever yours is running:
 *
 *   uvicorn chemclaw.api.app:create_app --factory --port 8080   (in the Chemclaw3 repo)
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
console.log(`  sandbox    http://127.0.0.1:${process.env.SANDBOX_PORT ?? '8788'}`);
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

// Node 22 strips TypeScript types natively, so the BFF runs from source with no build step.
// The HTML sandbox (artefacts wave 3): the BFF's second listener. The app origin is Vite's, because
// that is the page the browser frames it from; reach the app at exactly that address.
const SANDBOX_PORT = process.env.SANDBOX_PORT ?? '8788';

start('bff', process.execPath, ['--watch', 'server/index.ts'], {
  PORT: BFF_PORT,
  BIND_HOST: '127.0.0.1',
  SANDBOX_PORT,
  APP_ORIGIN: process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173',
  SANDBOX_ORIGIN: process.env.SANDBOX_ORIGIN ?? `http://127.0.0.1:${SANDBOX_PORT}`,
  CHEMCLAW_API_URL: API_URL,
  // The dev server serves the client; the BFF only proxies and serves /config.js.
  CLIENT_DIR: 'dist/client',
});

start('vite', process.execPath, ['node_modules/vite/bin/vite.js'], { BFF_PORT });
