/**
 * Ketcher, adapted to the sketcher seam — the only file that knows a drawing library exists
 * (everything else goes through `sketcher.ts`).
 *
 * Why Ketcher: Apache-2.0, maintained, React 19-compatible, and `ketcher-standalone` runs Indigo as
 * WASM in a worker (no drawing service). JSME's licence forbids modified redistribution;
 * openchemlib would be a second chemistry engine beside RDKit; Kekule.js fights lazily imported
 * ESM. Its output is taken as a molblock and read by RDKit.
 *
 * It is large (several MB of JS plus the Indigo `.wasm`), so it is reached only through
 * `sketcher.ts`'s dynamic import, and a failed load is retried.
 *
 * Build notes:
 *
 * - The three Ketcher packages are pinned to one exact version (a range let npm pick an
 *   incompatible `ketcher-core`).
 * - `ketcher-core` declares `node >= 24.14.1`; the npm warning is harmless (browser-only).
 * - Import `ketcher-standalone/dist/binaryWasm`, not the root (which inlines the WASM as base64).
 * - Ketcher needs a Node `global` (`ketcher.globals.ts`) and the undeclared `events` package (a
 *   direct dependency here).
 * - `staticResourcesUrl: ''` resolves assets against the app origin.
 */

// First, and on purpose: Ketcher reads a Node `global` when it is evaluated. See the module.
import './ketcher.globals.ts';
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

/**
 * Toolbar entries that cannot work here: `recognize` needs an image-recognition service, `miew` is
 * a 3D viewer.
 */
const HIDDEN_BUTTONS = {
  recognize: { hidden: true },
  miew: { hidden: true },
} as const;

export const mountKetcher: MountSketcher = async (host, initial) => {
  const root = createRoot(host);

  // Resolved with the editor instance. The wait is bounded by `toolkitLoad.ts`.
  const ready = new Promise<KetcherInstance>((resolve) => {
    root.render(
      <Editor
        staticResourcesUrl=""
        structServiceProvider={new StandaloneStructServiceProvider()}
        buttons={HIDDEN_BUTTONS}
        // Recoverable Ketcher problems go to the console; the editor carries on.
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
      // After `onInit`; a structure Indigo refuses leaves an empty, working editor.
      await instance.setMolecule(initial);
    } catch (err) {
      console.warn('[ketcher] could not open on the current structure', err);
    }
  }

  const session: SketcherSession = {
    async read() {
      // `getMolfile` throws or returns a zero-atom block for an empty canvas; both become `null`.
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
      // Unmounts the editor's React tree only. The Indigo worker is a page-wide singleton in
      // `ketcher-standalone`; terminating it would leave every later editor with a dead backend
      // (the slot is never refilled), so it is kept warm. `tests/ketcherWorker.test.ts` checks this
      // against the installed package.
    },
  };

  return session;
};
