/**
 * A stand-in for the Ketcher adapter, aliased over `src/chem/sketcher.ketcher.tsx` in
 * `vitest.config.ts`.
 *
 * Only the *adapter* is replaced, never the seam: `src/chem/sketcher.ts` — its module-promise
 * cache, its dynamic import, its degrade-to-null on failure — runs for real in every test that
 * opens the editor. That is the half worth testing, and it is the half a `vi.mock` of the seam
 * would have skipped.
 *
 * Behavioural for the same reason the RDKit fake is. It mounts something into the host element so
 * a test can prove the editor was given a place to live, it counts its own teardown so a dialog
 * that leaks a live editor is catchable, and it can be told to fail its mount so the "editor could
 * not be loaded, use paste or drop instead" path is reachable.
 *
 * Note what it does **not** do: it returns a molblock, not a SMILES, because that is the contract
 * the seam declares and the reason the drawing goes through RDKit rather than around it. A stub
 * that returned SMILES would let the production code stop canonicalising and no test would notice.
 */

import type { MountSketcher, SketcherSession } from '../../src/chem/sketcher.ts';

let drawing: string | null = null;
let mountShouldFail = false;
let destroyed = 0;

/** What `read()` will answer — an MDL molblock, or `null` for an untouched canvas. */
export const setDrawing = (molblock: string | null): void => {
  drawing = molblock;
};

/** Make the next mount throw, standing in for a chunk that would not load. */
export const setMountFailure = (fails: boolean): void => {
  mountShouldFail = fails;
};

/** How many mounted editors have been torn down. */
export const destroyCount = (): number => destroyed;

export const resetSketcherStub = (): void => {
  drawing = null;
  mountShouldFail = false;
  destroyed = 0;
};

export const mountKetcher: MountSketcher = async (host) => {
  if (mountShouldFail) throw new Error('stub sketcher refused to mount');

  host.setAttribute('data-sketcher', 'mounted');

  const session: SketcherSession = {
    read: async () => drawing,
    destroy: () => {
      destroyed += 1;
      host.removeAttribute('data-sketcher');
    },
  };
  return session;
};
