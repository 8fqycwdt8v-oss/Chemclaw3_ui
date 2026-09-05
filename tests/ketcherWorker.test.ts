// @vitest-environment node

/**
 * What `destroy()` can and cannot tear down, pinned against the package rather than believed.
 *
 * `StructureInput.tsx` said the dialog closing left no "live WASM heap behind a hidden node", and
 * `sketcher.ketcher.tsx`'s `destroy()` unmounts a React root. Read against the installed
 * `ketcher-standalone@3.17.2`, the Indigo worker survives all of that: it is created at *module*
 * scope, so it spawns on import rather than on mount, and every `IndigoService` takes that same
 * one. So the ~11.79 MB Indigo heap is retained from the first Draw click for the life of the
 * page, and the comment claiming otherwise was the defect.
 *
 * The package **does** ship a teardown — `IndigoService.destroy()` calls `worker.terminate()` —
 * which a first reading of this missed, and the third test below is the correction rather than a
 * decoration: what makes terminating wrong here is not that it is impossible but that it is
 * *one-way*. Module scope runs once and `loadSketcher` memoises the chunk, so a terminated worker
 * cannot be replaced and every later Draw click would mount an editor with a dead backend. The
 * fourth test is why nothing does it accidentally: `ketcher-react@3.17.2` never calls it.
 *
 * This asserts an **absence** as well as a presence, deliberately: if upstream grows a teardown,
 * these fail and the decision gets taken again instead of the comment quietly outliving its
 * reason. That is the same shape as the "does no document still claim …" checks in
 * `tests/routes.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
  it('is created once at module scope, so importing the chunk spawns it', () => {
    // Anchored at the start of a line: a `new Worker` inside a function body would be a worker per
    // editor, which is a different — and terminable — world.
    expect(worker).toMatch(/^var indigoWorker = new Worker\(/m);
  });

  it('is shared by every struct service rather than owned by one editor', () => {
    // `this.worker = indigoWorker` — so a second `createStructService()` does not get a second
    // worker, and terminating "ours" would terminate everyone's.
    expect(worker).toMatch(/this\.worker = indigoWorker/);
  });

  it('can be terminated — once, and only through the struct service', () => {
    // `IndigoService.destroy()`. Reachable from here by wrapping the provider to capture the
    // service Ketcher builds, and deliberately not called: see `sketcher.ketcher.tsx`.
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

describe('what this repository says about it', () => {
  it('no longer claims the dialog tears the WASM heap down', () => {
    // The exact sentence that was false, caught as itself. Whitespace-collapsed because the
    // comment wraps across lines.
    const source = read('src/components/StructureInput.tsx').replace(/\s+/g, ' ');
    expect(source).not.toMatch(/leaving a live WASM heap/);
  });

  it('says instead what is actually retained, and where the reading is', () => {
    const adapter = read('src/chem/sketcher.ketcher.tsx').replace(/\s+/g, ' ');
    expect(adapter).toMatch(/module\* scope/);
    expect(adapter).toMatch(/ketcher-standalone@3\.17\.2/);
  });
});
