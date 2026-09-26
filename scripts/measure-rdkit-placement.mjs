/**
 * W28.7's acceptance measurement: what the RDKit toolkit costs the main thread, before and after.
 *
 * One script, run against two trees, because that is the only way the two numbers are comparable.
 * The figures this row shipped with were recorded twice from two runs — `129 ms / 558 ms` in three
 * source files and `111 ms / 552 ms` in three others — which is a claim about somebody's afternoon
 * rather than about a commit. This file is what replaces both.
 *
 * It drives the app's own seam (`src/chem/rdkit.ts`) in a real Chromium through the Vite dev
 * server, because that is the only place the toolkit loads at all: behind the BFF, `script-src`
 * forbids the `Function(...)` Embind builds its invokers with, and RDKit answers nothing anywhere
 * (`ISSUES.md` Issue 10). So this measures placement, which is what W28.7 changed, and it cannot
 * measure the container, which is what Issue 10 is about.
 *
 * What it reports per call is the *main thread*, not the wall clock: a worker makes the second
 * bigger and the first zero, and only the first is what stops a frame from painting.
 *
 *   node scripts/measure-rdkit-placement.mjs            # this tree
 *   node scripts/measure-rdkit-placement.mjs --port 5178
 */

import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 5177;
const LENGTHS = [200, 600];

const vite = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort'],
  { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, BFF_PORT: '8787' } },
);
// Everything after the spawn is inside the `finally`, so a startup timeout, a browser that will
// not launch or a page that throws still releases the port. Before, only the success path killed
// the child, and an orphaned Vite on `--strictPort` failed every later run.
/** @type {import('@playwright/test').Browser | undefined} */
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vite did not start')), 60_000);
    vite.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      if (String(chunk).includes('ready in')) {
        clearTimeout(timer);
        setTimeout(resolve, 500);
      }
    });
    // A child that dies before it is ready (the port taken, under `--strictPort`) is an answer now,
    // not a 60 s wait for a line that will never come.
    vite.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`vite exited with ${code} before it was ready`));
    });
  });

  // The same resolution `playwright.config.ts` uses — the variable IS the executable path, and a
  // sandbox that has one has no downloaded browser for Playwright to fall back to.
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  );
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error('  page error:', error.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });

  const rows = await page.evaluate(async (lengths) => {
    const chem = await import('/src/chem/rdkit.ts');

    /** Total ms of `longtask` and the largest gap between animation frames, over one call. */
    const meter = () => {
      const tasks = [];
      const observer = new PerformanceObserver((list) => tasks.push(...list.getEntries()));
      observer.observe({ entryTypes: ['longtask'] });
      let last = performance.now();
      let widestFrame = 0;
      let running = true;
      const tick = () => {
        const at = performance.now();
        widestFrame = Math.max(widestFrame, at - last);
        last = at;
        if (running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return () => {
        running = false;
        observer.disconnect();
        return {
          blockedMs: Number(tasks.reduce((sum, t) => sum + t.duration, 0).toFixed(1)),
          longTasks: tasks.length,
          widestFrameMs: Number(widestFrame.toFixed(1)),
        };
      };
    };

    const time = async (fn) => {
      const stop = meter();
      const at = performance.now();
      const answer = await fn();
      const wallMs = Number((performance.now() - at).toFixed(1));
      // One more frame, so a long task that ran inside the awaited call is reported.
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 60)));
      return { wallMs, answered: answer !== null && answer !== undefined, ...stop() };
    };

    // Load the WASM before anything is timed: the first call pays for a 6.9 MB fetch and an
    // instantiation, which is a different fact and would swamp every number below.
    await chem.canonicalSmiles('CCO');
    await chem.moleculeSvg('CCO', {});

    const out = [];
    for (const length of lengths) {
      const smiles = 'C'.repeat(length);
      out.push({
        length,
        call: 'canonicalSmiles',
        ...(await time(() => chem.canonicalSmiles(smiles))),
      });
      out.push({
        length,
        call: 'moleculeSvg',
        ...(await time(() => chem.moleculeSvg(smiles, {}))),
      });
    }
    return out;
  }, LENGTHS);

  console.log(
    '\n  chars  call              wall ms   main-thread blocked ms   long tasks   widest frame ms   answered',
  );
  for (const r of rows) {
    console.log(
      `  ${String(r.length).padStart(5)}  ${r.call.padEnd(16)}  ${String(r.wallMs).padStart(7)}   ${String(r.blockedMs).padStart(22)}   ${String(r.longTasks).padStart(10)}   ${String(r.widestFrameMs).padStart(15)}   ${r.answered}`,
    );
  }
  console.log('');
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
process.exit(0);
