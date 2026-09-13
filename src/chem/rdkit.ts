/**
 * RDKit, loaded into the browser.
 *
 * This replaces `smiles-drawer`, and reversing that choice needs an argument rather than a
 * preference, because `Molecule.tsx` had written the old one down and it was right for what the
 * UI then did: smiles-drawer is pure JS, ~190 kB, and draws a SMILES string to SVG with no
 * initialisation — ideal when the only structures on screen came from a job summary and an
 * opt-in toggle on inline code spans. Three things this codebase now needs have no
 * smiles-drawer answer at all:
 *
 *  - **Canonical identity.** `COc1ccc(Br)cc1` and `BrC1=CC=C(OC)C=C1` are the same molecule and
 *    different strings. `src/chem/entities.ts` keys the conversation's subject index on the
 *    compound, so the two must collapse to one row — and no amount of string handling gets there.
 *    smiles-drawer parses; it does not canonicalise.
 *  - **Validation.** The recogniser in `recognise.ts` is deliberately looser than the rule it
 *    replaced, because that rule rejected ethanol. That is only safe if something can say "this is
 *    not a molecule" *before* it is drawn. smiles-drawer's parser can refuse a string, but it
 *    refuses a different set from RDKit's and it is the same object that draws — so a validation
 *    failure and a rendering failure are one event, and the recogniser has no arbiter.
 *  - **Molblock parsing.** `StructureInput` reads a dropped `.mol`/`.sdf`. smiles-drawer reads
 *    SMILES and nothing else, so the whole file path needs a toolkit that speaks MDL.
 *
 * The cost is real and the mitigation is structural rather than hopeful: this module is reached
 * only through a dynamic `import()`, so the WASM lands in its own chunk and **nothing chemical is
 * in the entry bundle or preloaded from index.html** — a page that shows no chemistry pays nothing.
 *
 * Measured across the swap alone, which is the number that tests the claim: the entry chunk went
 * 485.86 kB → 485.78 kB, with RDKit emitted as a 74 kB loader and a 6.9 MB `.wasm` beside it, both
 * fetched the first time a structure appears.
 *
 * **That delta is the claim; the absolute figure beside it was not, and this paragraph used to
 * publish one anyway.** It said the entry "ends this branch at 509 kB" while the same sentence in
 * `Molecule.tsx` said 485 kB — two numbers for one chunk, both stale.
 *
 * **No replacement number is written here, deliberately.** Measured twice within one afternoon on
 * 2026-09-05 the entry chunk read 505.90 kB and then 510.24 kB, moved by branches touching modules
 * it imports and by nothing in this file; splitting `routes.tsx` had moved it further still. A
 * byte count in prose is a claim about one commit, this file has now been wrong about it twice,
 * and the third attempt would go stale on the next merge. What is actually load-bearing is
 * structural — the only mention of this module or of Ketcher in the entry is the dynamic-import
 * reference to their chunks — so that is what `tests/entryChunk.test.ts` asserts, and `npm run
 * build:client` is where a current size comes from.
 *
 * What that trade buys back is one toolkit deciding what a molecule is. Keeping smiles-drawer for
 * depiction beside RDKit for identity was the other option on the table, and it was rejected for
 * that reason: a page with a rail has already fetched RDKit, so the 190 kB is duplicate
 * capability, and two parsers means two answers to "can this be drawn" that will disagree on some
 * string nobody has typed yet.
 *
 * **Loaded lazily and once, in a worker.** The WASM is fetched the first time a structure actually
 * appears and never again — and since W28.7 it is instantiated on a worker thread rather than on
 * the page. That is the whole shape of this module now: `rdkit.engine.ts` is every call that
 * touches the toolkit, `rdkit.worker.ts` runs it off the main thread, `rdkit.client.ts` decides
 * which of the two placements a call gets, and what is left here is the seam every caller imports
 * plus the one thing that must stay on this thread — the drawing cache, where a hit has to cost
 * nothing at all rather than a round trip.
 *
 * **The number that forced it.** The 600-character cap (`MAX_PARSED_SMILES_CHARS`, in the engine)
 * bounds the *unrecoverable* failure and was never able to bound the slow one: measured in real
 * Chromium through this module, a legal 600-character chain cost 129 ms to canonicalise and 558 ms
 * to draw, each one a single `longtask` with the frame loop stopped for its whole duration. That
 * is not a bug to be fixed — parsing and depicting a 300-bond chain is work — so the work moved
 * instead. Re-measured the same way afterwards: 1.6 ms and 4.4 ms on the main thread.
 *
 * **The CSP has to allow it, and today's does not.** Instantiating WASM needs `script-src
 * 'wasm-unsafe-eval'` (`server/config.ts`) — and that is necessary rather than sufficient, which
 * this paragraph asserted the opposite of for as long as it has existed. Embind builds this
 * package's invokers with `Function(...)`, which needs `'unsafe-eval'`, so behind the BFF the
 * loader throws and `rdkitAvailable()` answers `false` for the life of the page: measured, the
 * worker answers `toolkitLoads: false` and `drawSvg: null`, and every structure renders as its
 * SMILES with "the structure toolkit could not be loaded" beside it. `ISSUES.md` Issue 10 has the
 * evidence and the options. The reason nobody saw it is the other half of the old sentence, which
 * was right: the Vite dev server serves `index.html` itself and never applies the BFF's CSP, so
 * this fails *only* in the container — verify against `http://localhost:3000`, not `:5173`.
 *
 * **Every JSMol must be deleted.** They are C++ objects behind an Emscripten heap pointer, not
 * garbage-collected values, so a forgotten one leaks for the life of whichever thread owns the
 * heap. Nothing anywhere returns a JSMol; each helper in the engine owns its handles and frees
 * them in a `finally`. That is the whole reason these are functions over strings rather than a
 * "get me a molecule" API — and it is also what makes the worker possible at all, since a handle
 * could not have crossed a `postMessage` in the first place.
 */

import { call } from './rdkit.client.ts';
import type { DrawOptions } from './rdkit.engine.ts';

export { MAX_PARSED_SMILES_CHARS, tooLongToParse } from './rdkit.engine.ts';
export type { DrawOptions } from './rdkit.engine.ts';

/**
 * Is the toolkit actually here?
 *
 * The helpers below all answer chemistry questions, and `null`/`false` is their answer for "not a
 * molecule". That is the right shape for them and the wrong shape for "RDKit never loaded", which
 * is not a fact about the string at all. Collapsing the two is how the panel came to tell a
 * chemist that `CCO` is not a molecule, and how the composer's paste check went silent for the
 * page's lifetime.
 *
 * So the distinction lives here, and the rule is: **anything about to make a chemical claim on a
 * negative answer asks this first.** Not the helpers themselves — threading a third value through
 * every one of them puts the question at every call site instead of at the three that make a
 * claim, and `entities.ts` would have to handle a case it can do nothing about.
 *
 * It reports on the attempt that has already been made rather than commissioning another one,
 * which is what makes it cheap enough to ask from a render path. A caller that wants a *retry*
 * wants a molecule, and asks for one.
 */
export async function rdkitAvailable(): Promise<boolean> {
  return call('available');
}

/**
 * The canonical SMILES for `smiles`, or `null` if it is not a readable molecule.
 *
 * This is the entity key. Two spellings of one molecule must collapse to one string here or the
 * entity rail shows the same compound twice and can never join a computed value to the structure
 * it was computed for.
 */
export async function canonicalSmiles(smiles: string): Promise<string | null> {
  return call('canonicalSmiles', smiles);
}

/** Whether RDKit can read `smiles` as a molecule. The gate a recogniser's guess must pass before
 *  anything is drawn from it. */
export async function isMolecule(smiles: string): Promise<boolean> {
  return call('isMolecule', smiles);
}

/**
 * The canonical SMILES for an MDL molblock — a `.mol` file's contents, or one record of an `.sdf`.
 *
 * The same entry point as for SMILES; RDKit sniffs the format. So this is not here to reach a
 * different parser, it is here because **nothing outside the engine may hold a `JSMol`** and a
 * component that wanted to read a dropped file would otherwise have to. It also names the intent
 * at the call site, where "is this a molblock or a SMILES" is a question the caller has already
 * answered and the reader should not have to re-derive.
 *
 * The 2D coordinates in the block are deliberately dropped. The entity key and the text inserted
 * into a message are both SMILES, and `moleculeSvg` recomputes a depiction anyway — keeping the
 * drawn coordinates would mean two spellings of one compound again, this time geometric.
 */
export async function canonicalSmilesFromMolblock(molblock: string): Promise<string | null> {
  return call('canonicalSmilesFromMolblock', molblock);
}

/**
 * Drawings already made, newest use last.
 *
 * A depiction is a pure function of its four inputs, and nothing here memoised it, so every
 * *mount* re-parsed and redrew. Measured against the shipped binary over ten drug-like structures
 * (caffeine → atorvastatin): a mean of 5.40 ms and 12.5 kB of SVG each, from 2.81 ms/5.5 kB for
 * 4-bromoanisole to 9.71 ms/24 kB for atorvastatin. That is main-thread WASM time in a `useEffect`
 * with nothing between the calls, and this application redraws for reasons that have nothing to do
 * with chemistry: flipping the theme redraws everything visible, switching conversations remounts
 * the entity rail, and one molecule shown in three places is drawn three times. Measured on 20
 * structures — the rail plus a result grid — a theme toggle costs **111.6 ms** of blocked main
 * thread and, flipped back, another 108.7 ms; served from here the same 20 cost **0.02 ms**.
 *
 * **Bounded by characters, not by entries**, because the entries are not the same size: an SVG
 * here ranges from 2.0 kB for ethanol to 304 kB for the 600-character chain `MAX_PARSED_SMILES_CHARS`
 * still admits, so a count of 200 would admit anywhere between 0.4 MB and 60 MB. At the measured
 * 12.5 kB mean this budget holds ~160 drawings — both themes for ~80 distinct structures, which
 * covers the 50-hit structure grid and the rail together with room over — and 2 MB is small beside
 * the 6.9 MB heap this module is already holding open.
 */
const SVG_CACHE_BUDGET_CHARS = 2_000_000;

const svgCache = new Map<string, string>();
let svgCacheChars = 0;

/** All four inputs the drawing depends on. The size is in the key because the same structure is
 *  drawn at one canvas size here and the caller scales it; a future second size must not collide. */
const svgKey = (smiles: string, opts: DrawOptions): string =>
  `${opts.width}x${opts.height}|${opts.dark ? 'dark' : 'light'}|${smiles}`;

/**
 * Keep `svg`, evicting least-recently-used drawings until the budget is met again.
 *
 * **The replaced entry's length is subtracted.** `svgCacheChars` is the size of the map and this is
 * the only function that writes either, so keeping the two agreeing across a `set` that replaces is
 * this function's own job rather than a promise it extracts from its caller. Without it a key
 * written twice bills twice, the budget is understated by a whole drawing, and the cache evicts
 * entries it still has room for — which is the 111.6 ms this cache exists to end, coming back
 * quietly. Today no caller can reach that: `moleculeSvg` answers a hit before drawing and the
 * in-flight table below collapses concurrent misses on one key, which is exactly the pair that
 * used to reach it.
 */
function remember(key: string, svg: string): void {
  const replaced = svgCache.get(key);
  if (replaced !== undefined) svgCacheChars -= replaced.length;
  svgCache.set(key, svg);
  svgCacheChars += svg.length;
  // A `Map` iterates in insertion order and a hit re-inserts (see below), so the first key is the
  // least recently *used* rather than merely the oldest drawn. Deleting during iteration is
  // defined behaviour here — the iterator skips what has gone.
  for (const [oldest, drawn] of svgCache) {
    if (svgCacheChars <= SVG_CACHE_BUDGET_CHARS) return;
    // One drawing larger than the whole budget is kept anyway rather than evicted the instant it
    // arrives: the cache is then a cache of one, which is still the right answer for a page
    // showing that one structure.
    if (oldest === key) return;
    svgCache.delete(oldest);
    svgCacheChars -= drawn.length;
  }
}

/**
 * `smiles` drawn as an SVG, or `null` if it is not a molecule.
 *
 * The cache and the in-flight table are on **this** thread on purpose. A hit is the common case —
 * a theme toggle redraws everything visible, switching conversations remounts the rail — and the
 * whole value of a hit is that it costs nothing; answering one over a `postMessage` would put a
 * round trip and a 300 kB structured clone in front of a string this thread already holds.
 */
export async function moleculeSvg(smiles: string, opts: DrawOptions): Promise<string | null> {
  const key = svgKey(smiles, opts);
  const hit = svgCache.get(key);
  if (hit !== undefined) {
    // Re-inserted, which is what makes the eviction order above least-recently-used. Answered
    // before the toolkit is consulted on purpose: a drawing already made is a correct drawing of
    // that molecule whatever has happened to the runtime since, and withholding it because the
    // heap has died would replace a picture with a fallback for no gain.
    svgCache.delete(key);
    svgCache.set(key, hit);
    return hit;
  }

  // A drawing already under way is joined rather than started again. The cache above only helps
  // once a draw has *finished*, and the case this application actually produces is the other one:
  // one compound in the rail, the answer and a result card mounts three effects in the same tick,
  // all three miss, and all three ask for the same depiction — which is now one worker doing the
  // same work three times in series, so the waste is if anything worse than when it blocked here.
  // Keyed on the same four inputs as the cache, so two sizes or two themes of one structure are
  // still two drawings.
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

  // Only a drawing is kept. A `null` here is one of three different things — not a molecule, past
  // the length cap, or a runtime that has just died under the engine — and only the first is a
  // property of the input. Caching the other two would be the memoised-failure defect the loader
  // refuses, one layer up.
  if (drawn !== null) remember(key, drawn);
  return drawn;
}

/**
 * The structures in a `.mol` or `.sdf` file.
 *
 * **What a multi-record SDF does here, and why.** An SDF is a concatenation of molblocks separated
 * by a `$$$$` line, and a chemist's screening file routinely holds hundreds. Three options were on
 * the table: take the first record, refuse the file, or read them all. The first is the trap — it
 * silently discards data, and "silently dropped a reagent is a wrong table" is a failure this
 * codebase already names elsewhere. Refusing is defensible but unhelpful: the common case is a
 * two-record file where the chemist wants the second one.
 *
 * So every record is read and returned, and the caller shows one at a time with the count visible.
 * The composer inserts **one** structure per accept because one SMILES is what a message means;
 * a chemist who wants all of them steps through and inserts each. That keeps the "this is what I
 * understood you to mean" confirmation intact, which pasting a hundred structures in one action
 * would not.
 *
 * Records RDKit refuses are not returned — they cannot be drawn or compared — but they are counted,
 * because "12 of 15 records were readable" and "12 records" are different facts about a file.
 */
export interface MolfileRecords {
  /** Canonical SMILES, in file order. */
  smiles: string[];
  /** Records present in the file that RDKit could not read. */
  unreadable: number;
  /** Records past `MAX_SDF_RECORDS`, which were not read at all. */
  skipped: number;
  /** The toolkit itself never loaded. `unreadable` is then not a verdict about the file, and a
   *  caller that reported one would be telling a chemist their good `.sdf` holds no structures. */
  unavailable: boolean;
}

/**
 * The most records read from one file.
 *
 * Each one is a synchronous WASM parse — measured at ~0.9 ms after warm-up — and a screening
 * `.sdf` routinely holds tens of thousands, which is ~45 s of a frozen tab with "Reading …" as the
 * only feedback and no way to cancel. The cap is high enough for the files this panel is for (a
 * chemist steps through the records one at a time) and low enough that the wait stays about a
 * second. What is past it is counted and named rather than dropped in silence.
 */
export const MAX_SDF_RECORDS = 1000;

/** Records parsed between two turns of the event loop.
 *
 *  It used to be load-bearing: the `await` between records drained microtasks only, so without a
 *  real yield the browser could not paint for the whole file. Every parse is now a worker round
 *  trip, which is a macrotask on its own, so this no longer decides whether the tab paints — it
 *  decides how often. Kept rather than deleted because it costs one `setTimeout` per 25 records
 *  and is the only thing standing between this loop and a browser that coalesces message
 *  deliveries. */
const YIELD_EVERY = 25;

export async function moleculesFromMolfile(text: string): Promise<MolfileRecords> {
  // Asked once, up front. Without it every record comes back unreadable and the count becomes a
  // claim about the file rather than about the page.
  //
  // A real load attempt rather than `rdkitAvailable`, because this is a gate and not a
  // post-mortem: a
  // chemist dropping a file after an earlier load failed is exactly the retry the engine's catch
  // exists to allow, and `rdkitAvailable` deliberately answers from the last attempt instead of
  // making one.
  if (!(await call('toolkitLoads'))) {
    return { smiles: [], unreadable: 0, skipped: 0, unavailable: true };
  }

  const records = splitSdfRecords(text);
  const read = records.slice(0, MAX_SDF_RECORDS);
  const smiles: string[] = [];
  let unreadable = 0;

  for (const [index, record] of read.entries()) {
    if (index > 0 && index % YIELD_EVERY === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const canonical = await canonicalSmilesFromMolblock(record);
    if (canonical) smiles.push(canonical);
    else unreadable += 1;
  }

  return { smiles, unreadable, skipped: records.length - read.length, unavailable: false };
}

/**
 * Split SDF text into its records.
 *
 * Pure string handling, no RDKit: the delimiter is a line containing exactly `$$$$`, which is the
 * SDF spec and cannot appear inside a molblock's fixed-width atom or bond table. A plain `.mol`
 * file has no delimiter at all and comes back as a single record, which is why the caller does not
 * need to know which of the two it was handed.
 *
 * **A record's leading structure is load-bearing and must survive.** A molblock's header is four
 * *fixed* lines — title, program, comment, counts — and the title is routinely **blank**: that is
 * what `Chem.MolToMolBlock` writes by default, and what ChemDraw and most exporters write. This
 * used to `.trim()` each record, which ate the empty title line *and* the leading spaces of the
 * program line, so the counts line moved from index 3 to index 2, the parser read a program banner
 * as the atom/bond counts, and a perfectly valid `.mol` file was reported as "No structure found".
 *
 * So the delimiter is consumed together with the newline that ends it — that newline belongs to the
 * separator, not to the record after it — and only *trailing* whitespace is stripped. A leading
 * newline that is left is the record's own empty title line.
 */
export function splitSdfRecords(text: string): string[] {
  return text
    .split(/^\$\$\$\$[^\S\n]*\r?\n?/m)
    .map((record) => record.replace(/\s+$/, ''))
    .filter((record) => record !== '');
}
