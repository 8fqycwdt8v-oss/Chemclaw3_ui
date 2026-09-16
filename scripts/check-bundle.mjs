/**
 * Properties of the emitted bundle that no unit test can see, because they are facts about the
 * *build output* rather than about any module — its **shape**, and now its **size**.
 *
 *   node scripts/check-bundle.mjs [clientDir]     # default dist/client
 *
 * The shape assertions lived as inline shell in `.github/workflows/ci.yml`, which meant a
 * contributor could not run them without copy-pasting YAML — and a check nobody can run locally is
 * a check that is only ever read in a failed pipeline. They are the same assertions, moved.
 *
 * ## The budget, and why it is a first-party check
 *
 * This file policed what *lands* in the entry chunk — MSAL stays lazy, the RDKit worker is emitted
 * — and said nothing at all about how big any of it is. `tests/entryChunk.test.ts` states the
 * reason a size does not belong in prose ("a size in prose is a claim about one commit on one
 * branch") and asserts the *property* instead. What was missing is the other half: a number
 * somewhere a build can check, so that a dependency added next year meets a bound rather than a
 * reviewer's memory.
 *
 * `size-limit` was the obvious answer and is declined: it is a dependency, a config file and a
 * second way to read `dist/`, for an arithmetic this file already has the inputs for. What it
 * would buy — CI annotations, a hosted history — this repository does not use.
 *
 * ## What is budgeted is the FIRST LOAD, not the entry chunk
 *
 * Measured across this wave: adding `valibot`, `comlink` and `@tanstack/react-query` moved the
 * entry chunk by **4 bytes**, because Rolldown put the new code in `chatStore-*.js` and
 * `Feedback-*.js` — which the browser downloads at the same moment, from a `modulepreload` in
 * `index.html`. An entry-chunk budget would have reported a 13 kB gzipped change as nothing.
 *
 * So the budget is the entry plus every `modulepreload`d chunk: what a chemist downloads before
 * the app paints. Lazily-loaded chunks are deliberately outside it — Ketcher alone is 7.7 MB — and
 * the property that keeps them out of the first load is `tests/entryChunk.test.ts`'s, which is a
 * better control than a number for that job.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const CLIENT_DIR = process.argv[2] ?? process.env.CLIENT_DIR ?? 'dist/client';

/**
 * What the browser downloads before the app paints: the entry chunk and every `modulepreload`.
 *
 * Exported and taking the HTML as an argument so `tests/bundleBudget.test.ts` can drive it against
 * a fixture. Reading `dist/` is how it is *used*; what it knows is how Vite writes an entry into an
 * `index.html`, and that is a fact a test can pin without a build.
 *
 * Paths come back relative to the client directory, with the leading slash stripped, so a caller
 * can `join` them.
 */
export function firstLoadFiles(html) {
  const entry = /src="(\/assets\/index-[^"]+\.js)"/.exec(html)?.[1];
  const preloaded = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+\.js)"/g)].map(
    (match) => match[1],
  );
  return [entry, ...preloaded].filter(Boolean).map((path) => path.replace(/^\//, ''));
}

/**
 * The ceiling on the first load, and the headroom is the whole point of writing it here.
 *
 * **Measured on 2026-09-16**, against `dist/client` built by `npm run build:client`, summing the
 * entry and its eight `modulepreload`ed chunks — gzip at level 9, which is what
 * `scripts/compress-assets.mjs` writes and `sirv` serves:
 *
 *     before this wave (cca9e7a)   614,235 raw   194,918 gzip
 *     after  this wave             657,086 raw   207,927 gzip   (+42,851 / +13,009)
 *
 * attributed per change, gzip:
 *
 *     F1  navigator.locks        194,895   −23     (it deletes code and adds no bytes)
 *     F4a immer                  194,896    +1     (it lands in the lazy ProtocolDocument chunk)
 *     F4b comlink                196,314 +1,418
 *     F5  valibot                198,066 +1,752
 *     F6  @tanstack/react-query  207,927 +9,861
 *
 * The budget is set **above the measurement with the headroom stated**, rather than at it. A
 * ratchet pinned to the current byte reds on an unrelated merge and teaches everybody to raise it
 * without looking; a bound with room in it fails only when something meaningful arrives. ~6% is
 * roughly one more dependency of `react-query`'s weight — which is the size of decision this check
 * exists to make somebody take deliberately.
 *
 * Raising either number is a real decision and belongs in `docs/dependencies.md` with what it
 * bought, next to the row for whatever bought it.
 */
export const BUDGET = {
  firstLoadGzip: 220_000,
  firstLoadRaw: 700_000,
};

/** The measurement this budget was set from, so the headroom is checkable rather than asserted. */
export const MEASURED = {
  at: '2026-09-16',
  firstLoadGzip: 207_927,
  firstLoadRaw: 657_086,
};

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;

let failures = 0;
const ok = (label) => console.log(`  ✓ ${label}`);
const bad = (label, detail) => {
  failures += 1;
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
};

/**
 * Run the checks. A function rather than top-level code so that `tests/bundleBudget.test.ts` can
 * import `firstLoadFiles` and the budget without this script reading `dist/` and printing a report
 * as a side effect of the import — the same shape, and the same reason, as `scripts/ci.mjs`.
 */
function main() {
  let html;
  try {
    html = readFileSync(join(CLIENT_DIR, 'index.html'), 'utf8');
  } catch (err) {
    console.error(
      `check-bundle: cannot read ${join(CLIENT_DIR, 'index.html')} — run \`npm run build\` first.`,
    );
    console.error(String(err));
    exit(1);
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

  /* ── the first-load budget ────────────────────────────────────────────────── */

  {
    const files = firstLoadFiles(html);
    if (files.length === 0) {
      // A measurement over no files sums to zero and passes every budget. This is the one failure
      // mode of a size check that looks like success.
      bad(
        'found no first-load chunks in index.html',
        'this budget would pass by measuring nothing',
      );
    } else {
      let raw = 0;
      let gzip = 0;
      for (const file of files) {
        const bytes = readFileSync(join(CLIENT_DIR, file));
        raw += bytes.length;
        // Level 9, which is what `scripts/compress-assets.mjs` writes the `.gz` sidecars with and
        // therefore what `sirv` actually serves. A budget measured at a different level would be a
        // budget on a file nobody downloads.
        gzip += gzipSync(bytes, { level: 9 }).length;
      }
      console.log(`\n  first load: ${files.length} chunk(s), ${kb(raw)} raw, ${kb(gzip)} gzip`);
      for (const [label, measured, limit] of [
        ['gzip', gzip, BUDGET.firstLoadGzip],
        ['raw', raw, BUDGET.firstLoadRaw],
      ]) {
        const headroom = limit - measured;
        if (headroom < 0) {
          bad(
            `first load is ${kb(measured)} ${label}, over the ${kb(limit)} budget`,
            `${kb(-headroom)} over — see BUDGET in this file before raising it`,
          );
        } else {
          ok(
            `first load ${label} ${kb(measured)} / ${kb(limit)} — ` +
              `${kb(headroom)} headroom (${((100 * headroom) / limit).toFixed(1)}%)`,
          );
        }
      }
    }
  }

  console.log('');
  if (failures > 0) {
    console.error(`  ${failures} bundle failure${failures === 1 ? '' : 's'}.\n`);
    exit(1);
  }
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) main();
