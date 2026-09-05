/**
 * Ketcher, adapted to the sketcher seam.
 *
 * **The only file in this application that knows a drawing library exists.** Everything else goes
 * through `sketcher.ts`, and swapping Ketcher for something else means replacing this file and
 * nothing above it. That is the same containment `Molecule.tsx` keeps around the renderer, for the
 * same reason: a chemistry toolkit is a replaceable part right up until its API leaks upward.
 *
 * ## Why Ketcher
 *
 * Apache-2.0, actively maintained by EPAM, React 19 in its peer range, and — the deciding property —
 * `ketcher-standalone` runs Indigo as WASM in a worker, so drawing works with no drawing service to
 * deploy. The alternatives were weighed and rejected:
 *
 *  - **JSME** is smaller and battle-tested, but it is not open source; its licence permits use and
 *    forbids modification and redistribution of modified versions, which is a licence question this
 *    repo should not acquire for a composer affordance.
 *  - **openchemlib**'s built-in editor is BSD-3 and roughly a tenth the weight, and it was the close
 *    call. It loses on being a second chemical perception engine sitting permanently beside RDKit:
 *    this codebase's rule is that exactly one toolkit decides what a molecule is. Ketcher's output
 *    is taken as a molblock precisely so that stays true (see `sketcher.ts`), and openchemlib's
 *    smaller footprint buys nothing once both are behind the same lazy chunk boundary.
 *  - **Kekule.js** is MIT and capable but is built around global registration and jQuery-era module
 *    conventions that fight a lazily-imported ESM chunk.
 *
 * ## What it costs, and where
 *
 * Measured on 2026-09-05 with `npm run build:client`, because the figure this paragraph used to
 * carry — "roughly 3.4 MB of JavaScript" — was less than half of it. This module's own chunk is
 * **7.71 MB**; with the three it pulls in (`index.modern` ×2 and the Indigo worker) it is
 * **9.40 MB of JavaScript**, plus **180 kB** of Ketcher stylesheet and an **11.79 MB** Indigo
 * `.wasm`. None of it is in the main bundle: this module is reached only through `sketcher.ts`'s
 * dynamic `import()`, so a chemist who pastes SMILES and never draws downloads none of it, and the
 * entry chunk is unchanged by its presence — which is the claim that mattered and is still true.
 *
 * The size is also the argument for `sketcher.ts` retrying a failed load rather than memoising it:
 * at 7.71 MB for the first chunk alone, a dropped connection is an ordinary event, not a verdict
 * about the browser.
 *
 * ## Build-time notes that were not obvious
 *
 *  - **All three Ketcher packages are pinned to the same exact version**, and the caret is
 *    deliberately absent from `package.json`. `ketcher-react` declares `ketcher-core: "*"`, npm
 *    resolved that to a *three-minor-versions-older* core, and the build died on fourteen
 *    `MISSING_EXPORT` errors — `ketcher-react`'s bundle imports names that older core does not
 *    export. Nothing about the failure points at a version skew; it reads as a broken package. A
 *    range on any of the three re-opens it in the other direction.
 *  - `ketcher-core` declares `engines.node >= 24.14.1`, which this repo's `>= 22.6` does not
 *    satisfy, so `npm install` warns. It is a browser library and nothing here runs it in Node —
 *    but the warning is real and will keep appearing until one of the two moves.
 *  - `ketcher-standalone/dist/binaryWasm`, not the package root: the root inlines the WASM as
 *    base64 in a 21 MB JS file (see `ketcher-standalone.d.ts`).
 *  - The worker is created as `new Worker(new URL(…, import.meta.url), { type: 'module' })`, which
 *    Vite understands natively — no plugin, no config. It is also created at *module* scope inside
 *    ketcher-standalone, so the worker spawns on import rather than on mount, which is another
 *    reason this file must stay behind the dynamic import.
 *  - `staticResourcesUrl: ''` resolves Ketcher's own assets against the app origin. Anything it
 *    cannot find surfaces through `errorHandler` rather than throwing.
 */

import { createRoot } from 'react-dom/client';
import { Editor } from 'ketcher-react';
import { StandaloneStructServiceProvider } from 'ketcher-standalone/dist/binaryWasm';
import 'ketcher-react/dist/index.css';
import type { MountSketcher, SketcherSession } from './sketcher.ts';
import { withLoadTimeout } from './toolkitLoad.ts';

/** The sliver of Ketcher's instance this adapter uses. Narrow on purpose: it is the whole of the
 *  contract a replacement would have to satisfy. */
interface KetcherInstance {
  getMolfile: () => Promise<string>;
  /** Takes any format Indigo reads, SMILES included — which is what the panel has. */
  setMolecule: (structure: string) => Promise<void>;
}

/** Toolbar entries that cannot work here. `recognize` uploads an image to a structure-recognition
 *  service this deployment does not run, and `miew` opens a 3D viewer that is a different feature
 *  from "draw me a structure" — offering either would be a button that fails or that wanders. */
const HIDDEN_BUTTONS = {
  recognize: { hidden: true },
  miew: { hidden: true },
} as const;

export const mountKetcher: MountSketcher = async (host, initial) => {
  const root = createRoot(host);

  // Resolved *with* the editor rather than beside it, so everything after the await has a live
  // instance rather than a `| null` nothing can narrow.
  //
  // The wait is bounded by `toolkitLoad.ts`, which is where the 60 s this used to declare for
  // itself now lives: an unbounded wait is a dialog that spins for ever on a fetch nobody answers,
  // and the same sentence was true of `loadRDKit`, which had no bound at all. One number, two
  // seams, and the reasoning is written down once.
  const ready = new Promise<KetcherInstance>((resolve) => {
    root.render(
      <Editor
        staticResourcesUrl=""
        structServiceProvider={new StandaloneStructServiceProvider()}
        buttons={HIDDEN_BUTTONS}
        // Ketcher reports recoverable problems here — a template file it could not fetch, a
        // paste it could not parse. They are not reasons to tear the editor down, and they are
        // not ours to render, so they go to the console and the drawing carries on.
        errorHandler={(message) => console.warn('[ketcher]', message)}
        onInit={(ketcher) => resolve(ketcher as unknown as KetcherInstance)}
      />,
    );
  });

  let instance: KetcherInstance;
  try {
    instance = await withLoadTimeout(ready, 'The structure editor did not finish loading.');
  } catch (err) {
    root.unmount();
    throw err;
  }

  if (initial) {
    try {
      // After `onInit`, because the editor has no document to put a structure into before it. A
      // structure Indigo refuses is not a reason to fail the mount: an empty canvas is a working
      // editor, and a dialog that would not open is not.
      await instance.setMolecule(initial);
    } catch (err) {
      console.warn('[ketcher] could not open on the current structure', err);
    }
  }

  const session: SketcherSession = {
    async read() {
      // `getMolfile` throws on some empty-canvas paths and returns a zero-atom block on others.
      // Both mean "nothing drawn", and both have to reach the caller as the same `null` — a
      // difference in how Ketcher declines is not a difference a chemist should ever see.
      try {
        const molblock = await instance.getMolfile();
        return molblock.trim() ? molblock : null;
      } catch {
        return null;
      }
    },
    destroy() {
      // Deferred: React refuses to unmount a root synchronously from inside a render or an effect
      // of the tree being unmounted, and the close button that calls this is usually in one.
      setTimeout(() => root.unmount(), 0);
      // **This unmounts the editor's React tree and nothing else.** The Indigo heap stays, and it
      // stays on purpose. Read against the installed `ketcher-standalone@3.17.2`
      // (`dist/binaryWasm/main.js`): the worker is `var indigoWorker = new Worker(…)` at *module*
      // scope, so it spawns when this chunk is imported rather than when an editor mounts; every
      // `IndigoService` takes that same one (`this.worker = indigoWorker`); and `IndigoService`
      // does have a `destroy()` that calls `this.worker.terminate()`, which nothing in
      // `ketcher-react@3.17.2` ever calls.
      //
      // So it is terminable, and this is a decision rather than a limitation. Wrapping the
      // provider to capture the service Ketcher builds and calling its `destroy()` here would
      // free ~11.79 MB — **once**. Module scope runs a single time and `loadSketcher` memoises the
      // chunk, so nothing can spawn a second worker: the first close would leave every later Draw
      // click mounting an editor whose backend is dead, which surfaces as `onInit` never firing
      // and the 60 s load timeout, with the button still there offering itself. Trading a working
      // feature for one page's memory is the wrong way round; holding the heap warm for the next
      // click is the same bet the memoised chunk already makes.
      //
      // `tests/ketcherWorker.test.ts` pins all of it against the installed package, so an upstream
      // that spawns per service — the one change that would make terminating safe — turns this
      // comment red rather than letting it outlive its reason.
    },
  };

  return session;
};
