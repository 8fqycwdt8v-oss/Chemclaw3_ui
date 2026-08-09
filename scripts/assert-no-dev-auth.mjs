/**
 * Assert that a production bundle does not contain the no-token dev auth provider.
 *
 * `src/auth/index.ts` guards `createDevAuth` behind `import.meta.env.PROD` and the
 * `__ALLOW_DEV_AUTH__` define, and Vite currently eliminates the whole branch — verified: the
 * `dev@localhost` string is absent from a default build and present when `ALLOW_DEV_AUTH=true`.
 *
 * But dead-code elimination is a bundler optimisation, not a contract. A Rollup or Vite upgrade
 * that emits the dynamic import as a lazily-fetched chunk instead of dropping it would leave the
 * provider shipped and reachable, and nothing in the type system or the test suite would notice —
 * the guard would still *read* correctly. So the guarantee is asserted against the actual output.
 *
 * Run with ALLOW_DEV_AUTH=true, this asserts the opposite: the provider must be present, because
 * a deployment that deliberately opted in and silently got a bundle that throws on startup is the
 * same class of surprise pointing the other way.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLIENT_DIR = process.env.CLIENT_DIR ?? 'dist/client';
const ALLOWED = process.env.ALLOW_DEV_AUTH === 'true';

// Strings unique to `src/auth/devAuth.ts`. Its account literals, which no other module produces.
const MARKERS = ['dev@localhost', 'Dev principal'];

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(path));
    // .map files legitimately contain the source of every module the build considered, including
    // ones it dropped, so they would produce a false positive. They are stripped from the image
    // separately (see `scripts/build-server.mjs`).
    else if (entry.name.endsWith('.js')) out.push(path);
  }
  return out;
}

let files;
try {
  files = jsFiles(CLIENT_DIR);
} catch (err) {
  console.error(`assert-no-dev-auth: cannot read ${CLIENT_DIR}: ${err.message}`);
  console.error('Run `npm run build:client` first.');
  process.exit(1);
}

if (files.length === 0) {
  console.error(`assert-no-dev-auth: no .js files under ${CLIENT_DIR} — did the build run?`);
  process.exit(1);
}

const hits = files.filter((file) => {
  const source = readFileSync(file, 'utf8');
  return MARKERS.some((marker) => source.includes(marker));
});

if (ALLOWED) {
  if (hits.length === 0) {
    console.error(
      'assert-no-dev-auth: ALLOW_DEV_AUTH=true but the dev auth provider is NOT in the bundle. ' +
        'This build would throw on startup in dev mode.',
    );
    process.exit(1);
  }
  console.log(`assert-no-dev-auth: ok — dev auth deliberately included (${hits.length} chunk(s)).`);
  process.exit(0);
}

if (hits.length > 0) {
  console.error('assert-no-dev-auth: FAILED — the dev auth provider is present in a production');
  console.error('bundle built without ALLOW_DEV_AUTH=true. It sends no Authorization header, so');
  console.error('shipping it reachable is an authentication bypass. Offending chunks:');
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}

console.log(`assert-no-dev-auth: ok — ${files.length} chunk(s) checked, dev auth absent.`);
