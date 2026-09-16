/**
 * The three things `check-bundle.mjs` exports for `tests/bundleBudget.test.ts`.
 *
 * Hand-written, because `scripts/` is plain `.mjs` — `tsconfig.json` includes the directory for
 * the `.ts` scripts in it and does not turn on `allowJs`, so a `.d.mts` is how a checked file
 * imports from an unchecked one here. It declares only the budget surface; everything else in that
 * script is the executable half and is not imported by anything.
 *
 * It cannot drift silently in the direction that matters: every shape below is *used* by the test
 * beside it, so a rename in the script is a runtime `undefined` that fails an assertion rather
 * than a type that quietly agrees with itself.
 */

/** What the browser downloads before the app paints: the entry chunk and every `modulepreload`,
 *  relative to the client directory. */
export function firstLoadFiles(html: string): string[];

/** The ceiling, in bytes. */
export const BUDGET: { firstLoadGzip: number; firstLoadRaw: number };

/** What the ceiling was set from, in bytes, and when. */
export const MEASURED: { at: string; firstLoadGzip: number; firstLoadRaw: number };
