/**
 * What the page and the RDKit worker say to each other.
 *
 * Its own module because both sides import it and neither may import the other: the worker must
 * not pull the page's drawing cache into its bundle, and the page must not pull the worker's
 * dispatch into the chunk a chemist downloads. A shared type file is the whole of the coupling.
 *
 * **Nothing here is written by hand that the engine already says.** `Op`, the argument tuple and
 * the answer are derived from `rdkit.engine.ts`'s own `operations` table, so a new engine call is
 * one row there and nothing here — and, more to the point, a row whose signature changes cannot
 * leave a hand-copied wire type agreeing with a caller and disagreeing with the engine.
 *
 * **Every value crossing this boundary survives a structured clone.** That is a property of the
 * operations rather than of this file: each answers with a string, a boolean or `null`, and
 * `DrawOptions` is three plain fields. Nothing here carries a `JSMol`, and nothing could.
 */

import type { operations } from './rdkit.engine.ts';

/** The engine calls the worker serves. */
export type Op = keyof typeof operations;

/** What operation `K` takes. */
export type Args<K extends Op> = Parameters<(typeof operations)[K]>;

/** What operation `K` answers. */
export type Returns<K extends Op> = Awaited<ReturnType<(typeof operations)[K]>>;

export interface Request {
  id: number;
  op: Op;
  args: readonly unknown[];
}

/**
 * `ok: false` is the engine's own negative arriving by another route.
 *
 * Every engine call already answers "not a molecule" with `null` or `false` and swallows its own
 * exceptions, so a throw inside the worker means something structural — the module never loaded,
 * a clone failed. The client turns this back into that same negative, so no caller can tell which
 * thread answered it, which is exactly the property that lets the in-process fallback be the same
 * code path.
 */
export type Response = { id: number; ok: true; value: unknown } | { id: number; ok: false };
