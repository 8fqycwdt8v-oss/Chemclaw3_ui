// @vitest-environment node

/**
 * What `destroy()` can and cannot tear down, pinned against the package rather than believed.
 *
 * `StructureInput.tsx` said the dialog closing left no "live WASM heap behind a hidden node", and
 * `sketcher.ketcher.tsx`'s `destroy()` unmounts a React root. Read against the installed
 * `ketcher-standalone@3.18.0`, the Indigo worker survives all of that: it is a *page-wide
 * singleton* held in a module-scope slot (`_indigoWorker`) behind a memoising getter
 * (`getIndigoWorker()`), spawned by the first `IndigoService` and handed to every later one. So
 * the ~11.79 MB Indigo heap is retained from the first Draw click for the life of the page, and
 * the comment claiming otherwise was the defect. (Up to 3.17.2 the slot was filled eagerly —
 * `var indigoWorker = new Worker(…)` at module scope — so it spawned on import; 3.18 made it
 * lazy. The spawn moved; the singleton, and everything below, did not.)
 *
 * The package **does** ship a teardown — `IndigoService.destroy()` calls `worker.terminate()` —
 * which a first reading of this missed, and the third test below is the correction rather than a
 * decoration: what makes terminating wrong here is not that it is impossible but that it is
 * *one-way*. `destroy()` terminates the worker but never clears the slot, so the getter keeps
 * returning the dead one, and `loadSketcher` memoises the chunk so the slot is never re-created:
 * every later Draw click would mount an editor with a dead backend. The fourth test is why nothing
 * does it accidentally: `ketcher-react@3.18.0` never calls it.
 *
 * This asserts an **absence** as well as a presence, deliberately: if upstream grows a teardown,
 * these fail and the decision gets taken again instead of the comment quietly outliving its
 * reason. That is the same shape as the "does no document still claim …" checks in
 * `tests/routes.test.ts`.
 *
 * The third block is what the CSP in `server/config.ts` rests on: that this worker is a
 * same-origin network worker served under the document's policy, and needs nothing that policy
 * refuses. Read by shape, so a rename upstream (3.18's) passes and a change of kind fails.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isRdkitWorkerScript } from '../server/config.ts';

/** The build this application actually imports — `dist/binaryWasm`, not the package root, which
 *  inlines the WASM as base64 in a 21 MB file (see `src/chem/ketcher-standalone.d.ts`). Read off
 *  the installed tree by path rather than through `require.resolve`, which the package's own
 *  `exports` map refuses for this subpath even though its `index.js` imports it. */
const worker = readFileSync(
  new URL('../node_modules/ketcher-standalone/dist/binaryWasm/main.js', import.meta.url),
  'utf8',
);

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('the Indigo worker', () => {
  /** The name of the module-scope slot the worker lives in, whatever upstream calls it this
   *  release: the variable a memoising getter checks, fills with `new Worker(` and returns. */
  const slot =
    /^var (\w+) = null;\nfunction (\w+)\(\) \{\n\s*if \(!\1\) \{\n\s*\1 = new Worker\(/m.exec(
      worker,
    );

  it('is one per page: a module-scope slot filled once by a memoising getter', () => {
    // Anchored at the start of a line: the slot is declared at module scope, and the only
    // `new Worker(` in the bundle writes into it behind an `if (!slot)`. A `new Worker` that is
    // not memoised this way would be a worker per editor — a different, and terminable, world.
    expect(slot, 'no memoised module-scope worker slot in the bundle').not.toBeNull();
    expect(worker.match(/new Worker\(/g)).toHaveLength(1);
    const [, name, getter] = slot!;
    expect(worker).toMatch(new RegExp(`\\n\\s*return ${name};\\n\\}`));
    // Only the declaration and the getter write the slot — in particular nothing resets it to
    // `null` after a terminate, which would make a second spawn possible.
    expect(worker.match(new RegExp(`\\b${name} = `, 'g'))).toHaveLength(2);
    expect(worker).toMatch(new RegExp(`\\b${getter}\\(\\)`));
  });

  it('is shared by every struct service rather than owned by one editor', () => {
    // `this.worker = getIndigoWorker()` — so a second `createStructService()` does not get a
    // second worker, and terminating "ours" would terminate everyone's.
    const [, , getter] = slot!;
    expect(worker).toMatch(new RegExp(`this\\.worker = ${getter}\\(\\)`));
  });

  it('can be terminated — once, and only through the struct service', () => {
    // `IndigoService.destroy()`. Reachable from here by wrapping the provider to capture the
    // service Ketcher builds, and deliberately not called: see `sketcher.ketcher.tsx`. One-way
    // because it terminates without clearing the slot (pinned by the count in the first test).
    expect(worker).toMatch(/this\.worker\.terminate\(\)/);
  });

  it('is not torn down by the editor on unmount', () => {
    // The load-bearing absence. If `ketcher-react` started terminating it, the *second* Draw click
    // on a page would mount an editor whose backend is gone — a failure that looks like a network
    // problem and is not — and this repository would have to respond.
    const editor = readFileSync(
      new URL('../node_modules/ketcher-react/dist/index.js', import.meta.url),
      'utf8',
    );
    expect(editor).not.toMatch(/structService\w*\.destroy\(\)/);
    expect(editor).not.toMatch(/\.terminate\(\)/);
  });
});

describe('where the Indigo worker is served from', () => {
  /**
   * What the CSP in `server/config.ts` was written around: Ketcher's Indigo worker is a
   * *same-origin network* worker — `new Worker(new URL('<sibling>.js', import.meta.url))`, which
   * Vite compiles into a hashed chunk under `/assets/` — and so it runs under the policy of its own
   * response. The BFF sends that response the **document's** policy (`worker-src 'self'`,
   * `script-src 'self' 'wasm-unsafe-eval'`, no `'unsafe-eval'`), because only the RDKit worker's
   * chunk gets `RDKIT_WORKER_CSP`. Read by shape rather than by a variable name, which is what
   * 3.18 renamed (`indigoWorker` became `_indigoWorker` behind `getIndigoWorker()`); the browser
   * half of this is `e2e/rdkit.spec.ts`.
   */
  const call =
    /new Worker\(new URL\((["'])([^"'/]+\.js)\1, import\.meta\.url\), \{\s*type: 'module'\s*\}\)/.exec(
      worker,
    );
  /** The sibling module the worker is built from, `indigoWorker-<hash>.js` in 3.18. */
  const file = call?.[2] ?? '';

  it('is a module worker built from a same-origin URL, not a blob: or data: one', () => {
    // A `blob:`/`data:` worker would inherit the document's policy from a different rule, and a
    // cross-origin URL would be refused by `worker-src 'self'`. This form is the one Vite rewrites
    // to an emitted chunk next to the app's own.
    expect(
      call,
      'the Indigo worker is not `new Worker(new URL(<sibling>.js, import.meta.url))`',
    ).not.toBeNull();
    expect(worker.match(/new Worker\(/g)).toHaveLength(1);
    expect(
      existsSync(
        new URL(`../node_modules/ketcher-standalone/dist/binaryWasm/${file}`, import.meta.url),
      ),
      `${file} is not in the package`,
    ).toBe(true);
  });

  it('is served under the document policy, not the RDKit relaxation', () => {
    // The chunk Vite emits for it is `assets/<stem>-<hash>.js`; the relaxed policy is keyed to the
    // RDKit worker's name alone, so this worker must never match it.
    const stem = file.replace(/(-[0-9a-f]+)?\.js$/, '');
    expect(isRdkitWorkerScript(`/assets/${stem}-AbCd1234.js`)).toBe(false);
    expect(isRdkitWorkerScript(`/assets/${file}`)).toBe(false);
  });

  it('needs nothing that policy refuses: WASM compilation, but no eval', () => {
    // Under `script-src 'self' 'wasm-unsafe-eval'` a worker may instantiate WASM and may not
    // evaluate a string. RDKit's Embind glue does (hence its own policy); Indigo's must not, or the
    // sketcher would mount and then die on its first chemistry operation.
    const script = readFileSync(
      new URL(`../node_modules/ketcher-standalone/dist/binaryWasm/${file}`, import.meta.url),
      'utf8',
    );
    expect(script).toMatch(/WebAssembly\.instantiate/);
    expect(script).not.toMatch(/\bFunction\(|\beval\(/);
  });
});

describe('what Ketcher assumes the bundler provides', () => {
  // Neither is visible until an editor mounts in a production build, which is where both broke:
  // `e2e/rdkit.spec.ts` is the browser half.
  it('gets the `events` package that ketcher-core imports and does not declare', () => {
    const core = readFileSync(
      new URL('../node_modules/ketcher-core/dist/application/ketcher.modern.js', import.meta.url),
      'utf8',
    );
    const manifest = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
    if (/from 'events'/.test(core)) expect(manifest.dependencies).toHaveProperty('events');
  });

  it('gets a `global` before Ketcher is evaluated', () => {
    // First import, because ES modules evaluate theirs in order.
    const adapter = read('src/chem/sketcher.ketcher.tsx');
    expect(/^import .*$/m.exec(adapter)?.[0]).toBe("import './ketcher.globals.ts';");
  });
});
