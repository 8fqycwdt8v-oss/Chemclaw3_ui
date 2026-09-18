/**
 * `ISSUES.md` Issue 11's measurement: a chain *inside* the parser cap that is still answered `null`.
 *
 * `scripts/measure-rdkit-placement.mjs` measures what the toolkit costs the main thread, which is
 * a different question and answers at two lengths. This one answers "at what length does the seam
 * stop agreeing with the engine underneath it", which needs a sweep and needs a fresh page per
 * length — the whole finding is that the answer depends on the JavaScript stack at the moment of
 * the call rather than on the molecule, so a sweep inside one page measures a different thing from
 * a sweep across pages and the issue's own figures disagreed for exactly that reason.
 *
 * Each row is one length, and every column is a *later* call about the same string in the same
 * page, which is the only ordering that makes the numbers readable:
 *
 *  - `seam.canonical` — `src/chem/rdkit.ts`'s `canonicalSmiles`, the **first** call at this
 *    length, and the key a chemist's entity row is minted from. `null` here is the defect.
 *  - `read #2` and `read #3` — `readCanonicalSmiles` through the same placement, twice, three-
 *    valued. The first of these is what the fix is about: where the column before it reads `null`,
 *    this has to say *which* negative it is, because that decides the sentence a chemist is shown.
 *  - `engine` — `src/chem/rdkit.engine.ts` called straight from the page: same thread, same heap,
 *    same molecule, shallower stack. The control.
 *  - `isMolecule` and `moleculeSvg`, because "the same seam has the same problem" is an assumption
 *    until it is a column. Neither asks for a canonical name, so neither reaches the recursion.
 *
 * **Read the repeat columns before reading the first one as a threshold.** Measured here, the call
 * that refuses is the *first* one at a length — six consecutive `readCanonicalSmiles` at 600
 * characters in one page went `too-complex named named named named named`, and the same string
 * asked first refused and asked second answered. That is the issue's claim in one row: the refusal
 * is a fact about the JavaScript stack at the moment of the call, not about the molecule and not
 * about a length. A table with one row per length and no repeat column would publish a threshold
 * that does not exist, which is what the three measurements in `ISSUES.md` Issue 11 disagreed
 * about.
 *
 * **The blocked-main-thread column is what attributes an answer to a placement**, and it needs no
 * instrumentation inside the app: the worker blocks nothing, so 0 ms means the worker answered,
 * and anything above it means the worker threw and `rdkit.client.ts` re-ran the call here. A
 * `null` with a blocked main thread is therefore both placements refusing, which is the row this
 * script exists to produce.
 *
 * It measures, it never asserts, and it exits 0 whatever the numbers are — `tests/gate.test.ts`
 * lists it as tooling for that reason. What holds the behaviour is `tests/rdkitTooComplex.test.tsx`.
 *
 *   node scripts/measure-rdkit-rangeerror.mjs
 *   node scripts/measure-rdkit-rangeerror.mjs --lengths 550,600 --repeats 3 --port 5188
 */

import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1];
};

const port = Number(arg('port')) || 5188;
const lengths = (arg('lengths') ?? '200,300,400,500,550,570,580,590,600').split(',').map(Number);
const repeats = Number(arg('repeats')) || 1;

const vite = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort'],
  { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, BFF_PORT: '8787' } },
);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('vite did not start')), 60_000);
  vite.stdout.on('data', (chunk) => {
    if (String(chunk).includes('ready in')) {
      clearTimeout(timer);
      setTimeout(resolve, 500);
    }
  });
});

// The same resolution `playwright.config.ts` uses — the variable IS the executable path, and a
// sandbox that has one has no downloaded browser for Playwright to fall back to.
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
    : {},
);

/** One length, in a page of its own, because the stack this measures is the page's. */
async function probe(length) {
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error('  page error:', error.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  const row = await page.evaluate(async (length) => {
    const seam = await import('/src/chem/rdkit.ts');
    const engine = await import('/src/chem/rdkit.engine.ts');

    const timed = async (fn) => {
      const tasks = [];
      const observer = new PerformanceObserver((list) => tasks.push(...list.getEntries()));
      observer.observe({ entryTypes: ['longtask'] });
      const answer = await fn();
      // One more frame, so a long task that ran inside the awaited call is reported.
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 60)));
      observer.disconnect();
      return {
        answer,
        blockedMs: Number(tasks.reduce((sum, t) => sum + t.duration, 0).toFixed(1)),
      };
    };

    // Both placements warmed on a trivial molecule, so no number below is a 6.9 MB fetch.
    await seam.canonicalSmiles('CCO');
    await engine.readCanonicalSmiles('CCO');

    const smiles = 'C'.repeat(length);
    const viaSeam = await timed(() => seam.canonicalSmiles(smiles));
    const readSecond = await timed(() => seam.readCanonicalSmiles(smiles));
    const readThird = await timed(() => seam.readCanonicalSmiles(smiles));
    const viaEngine = await timed(() => engine.readCanonicalSmiles(smiles));
    const molecule = await timed(() => engine.isMolecule(smiles));
    const svg = await timed(() => seam.moleculeSvg(smiles, { width: 300, height: 200 }));
    return {
      length,
      seam: viaSeam.answer === null ? 'null' : 'answered',
      seamBlockedMs: viaSeam.blockedMs,
      readSecond: readSecond.answer.status,
      readThird: readThird.answer.status,
      // A status rather than a boolean: this is the whole subject of the measurement.
      engine: viaEngine.answer.status,
      engineBlockedMs: viaEngine.blockedMs,
      isMolecule: String(molecule.answer),
      svg: svg.answer === null ? 'null' : 'answered',
    };
  }, length);
  await page.close();
  return row;
}

const rows = [];
for (let run = 1; run <= repeats; run += 1) {
  for (const length of lengths) rows.push({ run, ...(await probe(length)) });
}

console.log(
  '\n  run  chars  seam.canonical  blocked   read #2      read #3      engine       blocked   isMolecule  moleculeSvg',
);
for (const r of rows) {
  console.log(
    `  ${String(r.run).padStart(3)}  ${String(r.length).padStart(5)}  ${r.seam.padEnd(14)}  ${String(r.seamBlockedMs).padStart(7)}   ${r.readSecond.padEnd(11)}  ${r.readThird.padEnd(11)}  ${r.engine.padEnd(11)}  ${String(r.engineBlockedMs).padStart(7)}   ${r.isMolecule.padEnd(10)}  ${r.svg}`,
  );
}
console.log('');

await browser.close();
vite.kill('SIGTERM');
process.exit(0);
