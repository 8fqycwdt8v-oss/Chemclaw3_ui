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
 * Roughly 3.4 MB of JavaScript plus an 11.8 MB Indigo `.wasm`, none of it in the main bundle: this
 * module is reached only through `sketcher.ts`'s dynamic `import()`, so a chemist who pastes SMILES
 * and never draws downloads none of it. Verified in `npm run build:client` — the Ketcher chunk and
 * the Indigo binary are separate emitted assets and the entry chunk is unchanged.
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

/** The sliver of Ketcher's instance this adapter uses. Narrow on purpose: it is the whole of the
 *  contract a replacement would have to satisfy. */
interface KetcherInstance {
  getMolfile: () => Promise<string>;
}

/** Toolbar entries that cannot work here. `recognize` uploads an image to a structure-recognition
 *  service this deployment does not run, and `miew` opens a 3D viewer that is a different feature
 *  from "draw me a structure" — offering either would be a button that fails or that wanders. */
const HIDDEN_BUTTONS = {
  recognize: { hidden: true },
  miew: { hidden: true },
} as const;

/** How long to wait for the editor to report itself ready before giving up. Indigo's WASM is
 *  ~12 MB, so this is generous — but unbounded would mean a dialog that spins forever on a failed
 *  fetch, and the caller's fallback (paste, drop) is better than that. */
const INIT_TIMEOUT_MS = 60_000;

export const mountKetcher: MountSketcher = async (host) => {
  const root = createRoot(host);
  let instance: KetcherInstance | null = null;

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('The structure editor did not finish loading.')),
      INIT_TIMEOUT_MS,
    );

    root.render(
      <Editor
        staticResourcesUrl=""
        structServiceProvider={new StandaloneStructServiceProvider()}
        buttons={HIDDEN_BUTTONS}
        // Ketcher reports recoverable problems here — a template file it could not fetch, a
        // paste it could not parse. They are not reasons to tear the editor down, and they are
        // not ours to render, so they go to the console and the drawing carries on.
        errorHandler={(message) => console.warn('[ketcher]', message)}
        onInit={(ketcher) => {
          clearTimeout(timer);
          instance = ketcher as unknown as KetcherInstance;
          resolve();
        }}
      />,
    );
  });

  try {
    await ready;
  } catch (err) {
    root.unmount();
    throw err;
  }

  const session: SketcherSession = {
    async read() {
      // `getMolfile` throws on some empty-canvas paths and returns a zero-atom block on others.
      // Both mean "nothing drawn", and both have to reach the caller as the same `null` — a
      // difference in how Ketcher declines is not a difference a chemist should ever see.
      try {
        const molblock = await instance?.getMolfile();
        return molblock?.trim() ? molblock : null;
      } catch {
        return null;
      }
    },
    destroy() {
      // Deferred: React refuses to unmount a root synchronously from inside a render or an effect
      // of the tree being unmounted, and the close button that calls this is usually in one.
      setTimeout(() => root.unmount(), 0);
    },
  };

  return session;
};
