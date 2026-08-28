/**
 * What `npm run test:e2e` needs on disk before a browser is worth starting.
 *
 * This tier serves `dist/client` through the real BFF with `AUTH_MODE=dev`, and a bare
 * `npm run build` produces a client that refuses exactly that: `vite.config.ts` defaults
 * `ALLOW_DEV_AUTH` to false, so `createAuthProvider` throws "AUTH_MODE=dev is not permitted in
 * this production build" the moment the SPA boots. Nothing in Playwright's output says so — the
 * throw is a browser-side unhandled rejection, and what the runner reports is every test that
 * needed a signed-in view timing out on a locator. Measured on the 2026-08-28 campaign: **40
 * timeouts at 30s each**, and two wrong hypotheses (load, then the branch under test) before the
 * browser log was read closely enough.
 *
 * `start.sh` already tracks `ALLOW_DEV_AUTH` to `AUTH_MODE`; this is the same rule for the harness,
 * as a `globalSetup` — it runs before the web server, it runs even when `reuseExistingServer`
 * skips the command, and its message is the entire output of a failed run.
 *
 * It asserts a *property of the artefact*, not the presence of an env var: the env var is set in
 * some other shell, at some earlier time, and what actually matters is whether the bundle standing
 * in `dist/client` carries the provider this tier will ask for. That is the same question
 * `scripts/assert-no-dev-auth.mjs` asks with `ALLOW_DEV_AUTH=true`, and it is asked here against
 * the dev provider's own literal rather than a copy of it, so a rename cannot leave this check
 * quietly passing on a string nothing emits any more.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDevAuth } from '../src/auth/devAuth.ts';

/** Where the built SPA is, for both the config's `webServer` and the check below. One literal. */
export const CLIENT_DIR = 'dist/client';

/** Where the bundled BFF is — `webServer` runs `node dist/server.js`. */
export const SERVER_BUNDLE = 'dist/server.js';

/**
 * A string only `src/auth/devAuth.ts` puts in a chunk, taken from the module itself.
 *
 * `dev@localhost` is the dev principal's username and no other module produces it, so finding it
 * in an emitted chunk is exactly "this build kept the no-token provider".
 */
const DEV_AUTH_MARKER = createDevAuth().account?.username ?? 'dev@localhost';

/** Every `.js` file under `dir`, recursively. `.map` files are excluded by the build, not here. */
function chunks(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...chunks(path));
    else if (entry.name.endsWith('.js')) out.push(path);
  }
  return out;
}

/**
 * What is wrong with this build, in sentences a reader can act on. Empty means "start the servers".
 *
 * Exported and pure so `tests/e2ePreflight.test.ts` can prove each message against a directory it
 * builds, rather than by breaking the real one.
 */
export function preflightProblems(clientDir: string, serverBundle: string): string[] {
  const problems: string[] = [];

  if (!existsSync(serverBundle)) {
    problems.push(
      `${serverBundle} is missing — the fixture tier runs the real BFF, not a stub. ` +
        `Run \`npm run build:server\` (or \`ALLOW_DEV_AUTH=true npm run build\`) first.`,
    );
  }

  const built = existsSync(clientDir) ? chunks(clientDir) : [];
  if (built.length === 0) {
    problems.push(
      `${clientDir} holds no JavaScript — there is no client to serve. ` +
        `Run \`ALLOW_DEV_AUTH=true npm run build\` first.`,
    );
    return problems;
  }

  const hasDevAuth = built.some((file) => readFileSync(file, 'utf8').includes(DEV_AUTH_MARKER));
  if (!hasDevAuth) {
    problems.push(
      `The client in ${clientDir} was built without ALLOW_DEV_AUTH=true, and this tier runs ` +
        `AUTH_MODE=dev. The SPA will throw "AUTH_MODE=dev is not permitted in this production ` +
        `build" on boot as an unhandled rejection, and every test needing a signed-in view will ` +
        `instead time out after 30s on a locator. Rebuild with ` +
        `\`ALLOW_DEV_AUTH=true npm run build\`.`,
    );
  }

  return problems;
}

/** Playwright's `globalSetup`. Throwing here is what stops the run before any browser opens. */
export default function preflight(): void {
  const problems = preflightProblems(CLIENT_DIR, SERVER_BUNDLE);
  if (problems.length > 0) throw new Error(`e2e preflight:\n  - ${problems.join('\n  - ')}`);
}
