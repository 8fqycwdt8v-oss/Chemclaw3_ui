/**
 * Three properties of the emitted bundle that no unit test can see, because they are facts about
 * the *build output* rather than about any module.
 *
 *   node scripts/check-bundle.mjs [clientDir]     # default dist/client
 *
 * Both of these lived as inline shell in `.github/workflows/ci.yml`, which meant a contributor
 * could not run them without copy-pasting YAML — and a check nobody can run locally is a check
 * that is only ever read in a failed pipeline. They are the same assertions, moved.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLIENT_DIR = process.argv[2] ?? process.env.CLIENT_DIR ?? 'dist/client';

let failures = 0;
const ok = (label) => console.log(`  ✓ ${label}`);
const bad = (label, detail) => {
  failures += 1;
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
};

let html;
try {
  html = readFileSync(join(CLIENT_DIR, 'index.html'), 'utf8');
} catch (err) {
  console.error(
    `check-bundle: cannot read ${join(CLIENT_DIR, 'index.html')} — run \`npm run build\` first.`,
  );
  console.error(String(err));
  process.exit(1);
}

console.log(`\nBundle shape, against ${CLIENT_DIR}\n`);

/* ── the runtime config script survives bundling ──────────────────────────── */

// Vite warns rather than fails when it cannot bundle a non-module script, so a refactor could
// silently drop this tag — and the app would then read its MSAL settings from nothing, in
// production only.
if (html.includes('src="/config.js"')) ok('index.html still loads /config.js');
else
  bad(
    'index.html no longer loads /config.js',
    'the app would read its runtime config from nothing',
  );

/* ── MSAL stays out of the entry chunk ────────────────────────────────────── */

// Auth is a seam with two implementations, and the dev path must not pay for the one it never
// uses. A static import would quietly pull ~230 kB of MSAL into every first load.
//
// The probe is `PublicClientApplication`, a class from @azure/msal-browser. Grepping for "msal"
// would false-positive on this app's own `authMode === 'msal'` comparisons and on the lazy
// chunk's filename, both of which legitimately appear in the entry.
const PROBE = 'PublicClientApplication';

const entryMatch = html.match(/src="(\/assets\/index-[^"]+\.js)"/);
if (!entryMatch) {
  bad('could not find the entry chunk in index.html', 'this check cannot run');
} else {
  const entry = join(CLIENT_DIR, entryMatch[1]);
  console.log(`    entry chunk: ${entry}`);
  if (readFileSync(entry, 'utf8').includes(PROBE)) {
    bad(`MSAL is inlined into the entry chunk`, 'it must stay dynamically imported');
  } else {
    ok('MSAL is not in the entry chunk');
  }

  // Positive control: if MSAL is in no chunk at all, the probe string has gone stale and the
  // check above would be passing for the wrong reason.
  const assets = join(CLIENT_DIR, 'assets');
  const chunks = readdirSync(assets).filter((name) => name.endsWith('.js'));
  const carrying = chunks.filter((name) =>
    readFileSync(join(assets, name), 'utf8').includes(PROBE),
  );
  if (carrying.length === 0) {
    bad(
      `${PROBE} was not found in any of ${chunks.length} chunks`,
      'this check has stopped testing anything — the probe string moved',
    );
  } else {
    ok(`MSAL is present in ${carrying.length} lazily-loaded chunk(s)`);
  }
}

/* ── the RDKit worker is emitted, and something loads it ──────────────────── */

// `src/chem/rdkit.client.ts` writes `new Worker(new URL('./rdkit.worker.ts', import.meta.url))`,
// which is the ONE spelling Vite compiles into an emitted chunk. Any other — a string path, a
// variable, a `new URL` built in two steps — is left exactly as written, so the build succeeds,
// the chunk is never emitted, and the worker 404s in the browser while every unit test stays green
// (happy-dom has no `Worker` at all, so the suite exercises the in-process fallback).
//
// Both directions, because either alone passes for the wrong reason: a chunk nobody references is
// dead weight, and a reference to a chunk that does not exist is the 404.
{
  const assets = join(CLIENT_DIR, 'assets');
  const names = readdirSync(assets);
  const workerChunk = names.find((name) => /^rdkit\.worker-.*\.js$/.test(name));
  const chunks = names.filter((name) => name.endsWith('.js'));
  const referring = workerChunk
    ? chunks.filter(
        (name) =>
          name !== workerChunk && readFileSync(join(assets, name), 'utf8').includes(workerChunk),
      )
    : [];

  if (!workerChunk) {
    bad('no rdkit.worker-*.js chunk was emitted', 'the toolkit would run on the main thread');
  } else if (referring.length === 0) {
    bad(
      `${workerChunk} is emitted but no chunk references it`,
      'nothing would ever construct the worker',
    );
  } else {
    ok(`the RDKit worker is emitted and referenced by ${referring.length} chunk(s)`);
  }
}

console.log('');
if (failures > 0) {
  console.error(`  ${failures} bundle-shape failure${failures === 1 ? '' : 's'}.\n`);
  process.exit(1);
}
