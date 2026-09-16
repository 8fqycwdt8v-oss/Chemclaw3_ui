import { expect, test } from '@playwright/test';

/**
 * W28.7 — the RDKit toolkit really is asked for on a worker thread in a real browser.
 *
 * Everything below this level can be true while this is false, and each of the layers says so:
 * `tests/rdkitWorker.test.ts` drives the client against a fake `Worker` because happy-dom has
 * none, and `scripts/check-bundle.mjs` proves the chunk is emitted and referenced. Neither can see
 * whether a browser *starts* it — a `worker-src` that went missing, a chunk the BFF will not
 * serve, a module worker a browser refuses. All three leave the app working, because
 * `rdkit.client.ts` falls back to the page on purpose, and silently give back the 587 ms of
 * blocked main thread the whole change is about (`scripts/measure-rdkit-placement.mjs`).
 *
 * **What this deliberately does not assert is that a structure is drawn, and the reason is a
 * defect this row measured rather than a gap in the test.** Under the CSP the BFF serves, RDKit
 * cannot load at all — on the page or in the worker. `@rdkit/rdkit`'s Embind glue builds its
 * invokers with `Function(...)`, which `script-src 'self' 'wasm-unsafe-eval'` forbids:
 * `'wasm-unsafe-eval'` permits WebAssembly compilation and nothing else. Driven against the built
 * bundle behind the real BFF, the loader throws `EvalError: Refused to evaluate a string as
 * JavaScript`, and the worker answers `toolkitLoads: false` and `drawSvg: null`. That predates
 * this change — the same probe fails identically with the pre-W28.7 tree — and it is filed in
 * `ISSUES.md`. The day it is fixed, this spec should grow the assertion it cannot make today:
 * that the `img` in the trace disclosure contains an `svg`.
 */

test('the app asks a worker for its chemistry, not the main thread', async ({ page }) => {
  const workers: import('@playwright/test').Worker[] = [];
  page.on('worker', (worker) => workers.push(worker));

  await page.goto('/');
  await page.getByPlaceholder(/Ask about a reaction/).fill('What is the pKa of acetic acid?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  // The turn has to reach a structure before anything asks the toolkit anything — the chemistry
  // chunk is dynamically imported and a page that shows no structure pays nothing, which is the
  // property `tests/entryChunk.test.ts` holds. The hazard screen's `Screened` list is that point.
  await expect(page.getByRole('heading', { name: 'Screened' })).toBeVisible({ timeout: 20_000 });

  // The *hashed* chunk Vite emitted, not merely a URL with the right word in it. A `new Worker`
  // written in a form Vite cannot compile still constructs a worker and still fires this event —
  // pointing at a path that 404s — so a name test alone passes with the feature deleted. Driven:
  // it did.
  const hashed = /\/assets\/rdkit\.worker-[A-Za-z0-9_-]{8,}\.js$/;
  await expect
    .poll(() => workers.filter((worker) => hashed.test(worker.url())).length, {
      message: `no RDKit worker chunk was started; workers seen: ${
        workers.map((w) => w.url()).join(', ') || 'none'
      }`,
      timeout: 15_000,
    })
    .toBeGreaterThan(0);

  // And it is running this repository's worker module, asked in its own protocol. A thread that
  // exists but never executed — a 404, a parse error, a CSP refusal of the script itself — answers
  // nothing here. The *value* is `false` in this deployment for the CSP reason above; what this
  // asserts is that the dispatch ran at all.
  const worker = workers.find((w) => hashed.test(w.url()))!;
  const reply = await worker.evaluate(
    () =>
      new Promise((resolve) => {
        const scope = self as unknown as { postMessage: (data: unknown) => void };
        const original = scope.postMessage.bind(self);
        // The app's own requests are in flight on this same channel, so replies are filtered by
        // id and everything else is passed straight through — intercepting the first reply that
        // arrives resolved with the page's `drawSvg` instead of this probe's.
        scope.postMessage = (data: unknown) => {
          if ((data as { id?: number }).id !== 99) {
            original(data);
            return;
          }
          scope.postMessage = original;
          resolve(data);
        };
        self.dispatchEvent(
          new MessageEvent('message', { data: { id: 99, op: 'isMolecule', args: ['CCO'] } }),
        );
        setTimeout(() => resolve('no reply'), 10_000);
      }),
  );
  expect(reply).toEqual({ id: 99, ok: true, value: false });
});
