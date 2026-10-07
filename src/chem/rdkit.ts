/**
 * RDKit, loaded into the browser — the seam every caller imports. RDKit (not a JS drawing library)
 * because the app needs canonical identity (the entity rail keys compounds on canonical SMILES),
 * validation before drawing (the recogniser is deliberately loose), and molblock parsing — from one
 * toolkit, so "can this be drawn" has one answer.
 *
 * Reached only through a dynamic `import()`, so nothing chemical is in the entry chunk
 * (`tests/entryChunk.test.ts`). The WASM runs on a worker: `rdkit.engine.ts` holds every call,
 * `rdkit.worker.ts` runs it, `rdkit.client.ts` picks the placement, and this module keeps the
 * drawing cache on the calling thread. `scripts/measure-rdkit-placement.mjs` measures the
 * main-thread cost.
 *
 * The document CSP never grants `'unsafe-eval'`; the worker's script gets `RDKIT_WORKER_CSP`
 * (`server/config.ts`), which Embind needs. Behind the BFF the in-process fallback therefore cannot
 * load the toolkit (it says so), and a worker stack exhaustion is reported as `too-complex` instead
 * of retried on the page. Verify behind the BFF; the Vite dev server sends no CSP.
 *
 * Every `JSMol` must be deleted; none ever leaves the engine, which is also why a worker is
 * possible.
 */

import { call } from './rdkit.client.ts';
import type { CanonicalRead, DrawOptions } from './rdkit.engine.ts';

export { MAX_PARSED_SMILES_CHARS, tooLongToParse } from './rdkit.engine.ts';
export type { CanonicalRead, DrawOptions, NotAChemicalVerdict, Refused } from './rdkit.engine.ts';

/**
 * Whether the toolkit loaded. Helpers answer `null`/`false` for "not a molecule", so anything about
 * to make a chemical claim on a negative asks this first. Reports the last attempt (cheap on a
 * render path); ask for a molecule to retry.
 */
export async function rdkitAvailable(): Promise<boolean> {
  return call('available');
}

/**
 * What RDKit made of `smiles`: its canonical SMILES, or a `Refused` reason (`rdkit.engine.ts`). The
 * third value is threaded only to the surfaces that make a claim (`StructureInput.tsx`,
 * `structure.ts`); `canonicalSmiles` narrows it for everyone else.
 */
export async function readCanonicalSmiles(smiles: string): Promise<CanonicalRead> {
  return call('readCanonicalSmiles', smiles);
}

/**
 * The canonical SMILES for `smiles` (the entity key), or `null`. Both refusals are `null`: the raw
 * spelling must never become a key (`tests/rdkitUnavailable.test.tsx`,
 * `tests/rdkitTooComplex.test.tsx`).
 */
export async function canonicalSmiles(smiles: string): Promise<string | null> {
  const read = await readCanonicalSmiles(smiles);
  return read.status === 'named' ? read.canonical : null;
}

/** Whether RDKit can read `smiles` as a molecule. The gate a recogniser's guess must pass before
 *  anything is drawn from it. */
export async function isMolecule(smiles: string): Promise<boolean> {
  return call('isMolecule', smiles);
}

/**
 * A molblock (`.mol` or one `.sdf` record) as canonical SMILES, or a `Refused` reason. 2D
 * coordinates are dropped. Every caller makes a claim off the answer, so there is no narrowed
 * variant.
 */
export async function readCanonicalSmilesFromMolblock(molblock: string): Promise<CanonicalRead> {
  return call('readCanonicalSmilesFromMolblock', molblock);
}

/**
 * `smiles` as an MDL molblock for an SDF built here, or `null`; callers ask `rdkitAvailable()` to
 * say why.
 */
export async function molblockOf(smiles: string): Promise<string | null> {
  return call('molblock', smiles);
}

/**
 * Drawings already made, least recently used first. A depiction is a pure function of its inputs
 * and the app redraws often (theme toggles, remounts, one molecule in several places), so a hit
 * must cost nothing. Bounded by characters, not entries: an SVG ranges from ~2 kB to ~300 kB.
 */
const SVG_CACHE_BUDGET_CHARS = 2_000_000;

const svgCache = new Map<string, string>();
let svgCacheChars = 0;

/** All four inputs the drawing depends on. The size is in the key because the same structure is
 *  drawn at one canvas size here and the caller scales it; a future second size must not collide. */
const svgKey = (smiles: string, opts: DrawOptions): string =>
  `${opts.width}x${opts.height}|${opts.dark ? 'dark' : 'light'}|${smiles}`;

/**
 * Keep `svg`, evicting least-recently-used drawings until within budget. A replaced entry's length
 * is subtracted so the count stays exact.
 */
function remember(key: string, svg: string): void {
  const replaced = svgCache.get(key);
  if (replaced !== undefined) svgCacheChars -= replaced.length;
  svgCache.set(key, svg);
  svgCacheChars += svg.length;
  // Insertion order plus re-insert on hit makes the first key the least recently used.
  for (const [oldest, drawn] of svgCache) {
    if (svgCacheChars <= SVG_CACHE_BUDGET_CHARS) return;
    // A single drawing larger than the budget is kept anyway.
    if (oldest === key) return;
    svgCache.delete(oldest);
    svgCacheChars -= drawn.length;
  }
}

/**
 * `smiles` as an SVG, or `null`. The cache and in-flight table live on this thread so a hit avoids
 * a worker round trip.
 */
export async function moleculeSvg(smiles: string, opts: DrawOptions): Promise<string | null> {
  const key = svgKey(smiles, opts);
  const hit = svgCache.get(key);
  if (hit !== undefined) {
    // Re-inserted for LRU order, and answered before consulting the toolkit: a finished drawing
    // stays correct even if the runtime has since died.
    svgCache.delete(key);
    svgCache.set(key, hit);
    return hit;
  }

  // Join a drawing already under way (the same compound often mounts in several places in one
  // tick). Keyed on all four inputs.
  const drawing = inFlight.get(key);
  if (drawing) return drawing;
  const started = drawOnce(key, smiles, opts);
  inFlight.set(key, started);
  try {
    return await started;
  } finally {
    inFlight.delete(key);
  }
}

/** Draws in progress, so concurrent callers for one key share one depiction. */
const inFlight = new Map<string, Promise<string | null>>();

/** One depiction, from the engine to the cache. Split out of `moleculeSvg` so the in-flight table
 *  above holds a promise that is already running before any caller awaits it. */
async function drawOnce(key: string, smiles: string, opts: DrawOptions): Promise<string | null> {
  const drawn = await call('drawSvg', smiles, opts);

  // Only drawings are cached; a `null` may be a transient failure rather than a property of the
  // input.
  if (drawn !== null) remember(key, drawn);
  return drawn;
}

/**
 * The structures in a `.mol` or `.sdf` file. Every record is read and returned; the caller shows
 * one at a time with the count and inserts one per accept. Refused records are not returned but are
 * counted by reason, since "too complex" is not "unreadable".
 */
export interface MolfileRecords {
  /** Canonical SMILES, in file order. */
  smiles: string[];
  /** Records present in the file that RDKit could not read. */
  unreadable: number;
  /**
   * Records RDKit read but could not name on this thread (`too-complex`), counted apart from
   * `unreadable`.
   */
  tooComplex: number;
  /** Records past `MAX_SDF_RECORDS`, which were not read at all. */
  skipped: number;
  /** The toolkit itself never loaded. `unreadable` is then not a verdict about the file, and a
   *  caller that reported one would be telling a chemist their good `.sdf` holds no structures. */
  unavailable: boolean;
}

/**
 * The most records read from one file (each parse is ~1 ms; screening files can hold tens of
 * thousands). What is past it is counted and named.
 */
export const MAX_SDF_RECORDS = 1000;

/** Records parsed between two turns of the event loop, so the page keeps painting. */
const YIELD_EVERY = 25;

export async function moleculesFromMolfile(text: string): Promise<MolfileRecords> {
  // Ask once whether the toolkit loads, or every record would read as unreadable. A real attempt
  // (not `rdkitAvailable`), so a drop after a failed load retries.
  if (!(await call('toolkitLoads'))) {
    return { smiles: [], unreadable: 0, tooComplex: 0, skipped: 0, unavailable: true };
  }

  const records = splitSdfRecords(text);
  const read = records.slice(0, MAX_SDF_RECORDS);
  const smiles: string[] = [];
  let unreadable = 0;
  let tooComplex = 0;

  for (const [index, record] of read.entries()) {
    if (index > 0 && index % YIELD_EVERY === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const verdict = await readCanonicalSmilesFromMolblock(record);
    switch (verdict.status) {
      case 'named':
        smiles.push(verdict.canonical);
        break;
      case 'unreadable':
        unreadable += 1;
        break;
      case 'too-complex':
        tooComplex += 1;
        break;
      default: {
        // A refusal added to `Refused` must be counted somewhere on purpose, not folded into
        // whichever branch a `default` would have picked.
        const unanswered: never = verdict;
        throw new Error(`unhandled molblock verdict: ${String(unanswered)}`);
      }
    }
  }

  return {
    smiles,
    unreadable,
    tooComplex,
    skipped: records.length - read.length,
    unavailable: false,
  };
}

/**
 * Split SDF text into records on `$$$$` lines; a `.mol` file is one record. Only trailing
 * whitespace is stripped: a molblock's header is four fixed lines and the title is often blank, so
 * trimming the start would shift the counts line.
 */
export function splitSdfRecords(text: string): string[] {
  return text
    .split(/^\$\$\$\$[^\S\n]*\r?\n?/m)
    .map((record) => record.replace(/\s+$/, ''))
    .filter((record) => record !== '');
}
