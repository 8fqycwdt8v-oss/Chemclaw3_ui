/**
 * The 2D sketcher, behind a seam.
 *
 * Nothing in this application imports a drawing library. It imports *this*, which promises one
 * thing — mount an editor into an element and later hand back a molblock — and keeps the identity
 * of the editor to itself and to its adapter (`sketcher.ketcher.tsx`, the only file that names
 * Ketcher). The discipline is the one `Molecule.tsx` describes for the renderer: the chemistry
 * library is a replaceable part, and the way you keep it replaceable is by having exactly one file
 * that changes when it is replaced.
 *
 * ## Why a molblock and not the sketcher's SMILES
 *
 * Ketcher will export SMILES perfectly well. Taking it would mean trusting a second toolkit's
 * chemical perception — aromaticity, stereo, charges — to agree with RDKit's, and it does not
 * always. Worse, it would mean a string reaching the entity store and the message box that RDKit
 * never read, in a codebase whose whole rule is that RDKit is the arbiter. A molblock is a
 * connectivity table, not an interpretation; handing that to RDKit and taking its canonical SMILES
 * means one toolkit decides what the molecule is, and it is the same one that decides everywhere
 * else. `canonicalSmilesFromMolblock` is the gate.
 *
 * ## Why the loader looks like `loadRDKit`
 *
 * Same problem, same shape: a multi-megabyte dependency that a chemist who never draws must not
 * pay for. The dynamic `import()` is what puts Ketcher and its Indigo WASM in their own chunks, the
 * module promise is cached so a second Draw click does not refetch, and a failure resolves to
 * `null` rather than throwing — a browser that cannot load the editor should offer the paste and
 * drop paths, not a blank dialog.
 *
 * ## The CSP
 *
 * Ketcher's chemistry runs in a Web Worker that instantiates WASM, so `worker-src` and
 * `script-src 'wasm-unsafe-eval'` both have to allow it (`server/config.ts`). As with RDKit, a
 * missing directive fails *only* behind the BFF — the Vite dev server never sends the header — so
 * this is verified against `http://localhost:3000`, not `:5173`.
 */

/** A mounted editor. Live until `destroy`; the caller owns its lifetime the way it owns the host. */
export interface SketcherSession {
  /**
   * The current drawing as an MDL molblock, or `null` if there is nothing on the canvas.
   *
   * Not SMILES: see above. Not validated here either — validation is RDKit's, and doing it here
   * would put a chemistry decision inside the adapter boundary where a swap could quietly change
   * it.
   */
  read: () => Promise<string | null>;
  destroy: () => void;
}

/**
 * Mount an editor into `host`, optionally opening it on `initial`.
 *
 * `initial` is anything the editor's own chemistry engine can read — this application passes the
 * canonical SMILES the panel has already confirmed. Without it the seam was write-only in one
 * direction and the round trip the panel implies did not exist: draw, insert, press Draw again,
 * blank canvas. A chemist correcting one bond redrew the whole molecule, and the two drawings were
 * then two independent chances to get it wrong.
 *
 * Loading it is best-effort *inside* the adapter: an editor that came up empty is worth more than
 * a dialog that failed to open, so a structure the editor refuses must not take the mount with it.
 */
export type MountSketcher = (host: HTMLElement, initial?: string) => Promise<SketcherSession>;

/** Resolved once, then reused. `null` once loading has failed, so a browser that cannot run the
 *  editor degrades to the paste and drop paths instead of retrying on every click. */
let mountPromise: Promise<MountSketcher | null> | null = null;

export function loadSketcher(): Promise<MountSketcher | null> {
  mountPromise ??= (async () => {
    try {
      const module = await import('./sketcher.ketcher.tsx');
      return module.mountKetcher;
    } catch {
      return null;
    }
  })();
  return mountPromise;
}
