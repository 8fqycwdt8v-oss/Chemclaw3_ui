/**
 * What the page may ask the RDKit worker for, derived from the engine rather than declared.
 *
 * **Nothing here is written by hand that the engine already says.** `Op`, the argument tuple and
 * the answer come out of `rdkit.engine.ts`'s own `operations` table, so a new engine call is one
 * row there and nothing here — and, more to the point, a row whose signature changes cannot leave a
 * hand-copied wire type agreeing with a caller and disagreeing with the engine.
 *
 * It used to carry a `Request`/`Response` envelope as well, with an id, an `ok` flag and an
 * `unknown` payload that the client re-narrowed. Comlink carries the envelope now and
 * `Comlink.Remote<typeof operations>` types it, so what is left here is only the part that is
 * *this app's*: which calls exist and what they take. It stays its own module rather than being
 * inlined into `rdkit.client.ts` because the answer to "what may cross the worker boundary" is a
 * question about the boundary, not about the one file that currently asks it.
 *
 * **Every value crossing that boundary survives a structured clone.** That is a property of the
 * operations rather than of this file: each answers with a string, a boolean, `null` or — since
 * `readCanonicalSmiles` had to carry a reason as well as a name — a plain object of string
 * literals, and `DrawOptions` is three plain fields. Nothing here carries a `JSMol`, and nothing
 * could. A discriminated union is worth naming as the case to watch: it clones because every arm
 * is data, and it would stop the day somebody put a class instance, a `Symbol` or an `Error` in
 * one, which is precisely how a reason for a failure tends to get carried.
 */

import type { operations } from './rdkit.engine.ts';

/** The engine calls the worker serves. */
export type Op = keyof typeof operations;

/** What operation `K` takes. */
export type Args<K extends Op> = Parameters<(typeof operations)[K]>;

/** What operation `K` answers. */
export type Returns<K extends Op> = Awaited<ReturnType<(typeof operations)[K]>>;
