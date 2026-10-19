/**
 * The 2D sketcher behind a seam: mount an editor, later get a molblock. Only the adapter
 * (`sketcher.ketcher.tsx`) names Ketcher.
 *
 * A molblock, not the sketcher's SMILES: a connectivity table that RDKit then interprets
 * (`readCanonicalSmilesFromMolblock`), so one toolkit decides what the molecule is.
 *
 * Loaded like `loadRDKit`: a dynamic `import()` in its own chunks, the module promise cached,
 * failures resolve to `null` and are not memoised (a dropped connection on a multi-MB chunk is
 * common). Ketcher's worker needs `worker-src` and `'wasm-unsafe-eval'` (`server/config.ts`);
 * verify behind the BFF, not Vite.
 */

/** A mounted editor. Live until `destroy`; the caller owns its lifetime the way it owns the host. */
export interface SketcherSession {
  /**
   * The current drawing as an MDL molblock, or `null` if empty. Not validated here; that is RDKit's
   * job.
   */
  read: () => Promise<string | null>;
  destroy: () => void;
}

/**
 * Mount an editor into `host`, optionally opening `initial` (the canonical SMILES already
 * confirmed), so a correction continues the drawing. Loading `initial` is best-effort: an empty
 * editor beats a dialog that failed to open.
 */
export type MountSketcher = (host: HTMLElement, initial?: string) => Promise<SketcherSession>;

/** Resolved once, then reused. Only a *success* is kept — see the catch below. */
let mountPromise: Promise<MountSketcher | null> | null = null;

export function loadSketcher(): Promise<MountSketcher | null> {
  const pending = (mountPromise ??= (async () => {
    try {
      const module = await import('./sketcher.ketcher.tsx');
      return module.mountKetcher;
    } catch {
      // Cleared so the next Draw click retries; no retry counter, since every retry is a click. A
      // dynamic import whose fetch failed may stay errored for that URL; evaluation failures and
      // Vite's modulepreload failures are recoverable.
      mountPromise = null;
      return null;
    }
  })());
  return pending;
}
