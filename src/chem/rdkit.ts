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
 * **Loaded lazily and once.** The module promise is cached here, so the WASM is fetched the first
 * time a structure actually appears and never again.
 *
 * **The CSP has to allow it.** Instantiating WASM needs `script-src 'wasm-unsafe-eval'`
 * (`server/config.ts`). The Vite dev server serves `index.html` itself and never applies the BFF's
 * CSP, so a missing directive here fails *only* in the container — verify against
 * `http://localhost:3000`, not against `:5173`.
 *
 * **Every JSMol must be deleted.** They are C++ objects behind an Emscripten heap pointer, not
 * garbage-collected values, so a forgotten one leaks for the page's lifetime. Nothing in this
 * module returns a JSMol; each helper owns its handles and frees them in a `finally`. That is the
 * whole reason these are functions over strings rather than a "get me a molecule" API.
 */

import type { JSMol, RDKitLoader, RDKitModule } from '@rdkit/rdkit';
import { withLoadTimeout } from './toolkitLoad.ts';

/**
 * The longest SMILES this module will hand to `get_mol`, and the reason there has to be one.
 *
 * **RDKit's WASM traps on a long enough chain, and a trap is not recoverable.** Measured against
 * the shipped binary (`@rdkit/rdkit` 2025.3.4-1.0.0), a chain of ~1040 carbons or more raises
 * `RuntimeError: memory access out of bounds` inside `get_mol` — Emscripten aborts the runtime,
 * and *every* later call into the same module throws too. `withMol` catches, so what the chemist
 * then sees is "Could not render this structure" and "RDKit could not read this as a molecule"
 * about `CCO`, for the rest of the tab's life, with `rdkitAvailable()` still answering `true`
 * because the module did load. Nothing short of a reload recovers it.
 *
 * It is reachable with no user action: `Markdown` renders an inline code span through
 * `InlineSmiles`, which parses on mount, and `looksLikeSmiles` accepts `'CC'.repeat(600)` — a
 * polymer or a PEG linker written out longhand. `<Molecule>` takes the backend's own
 * `molecule_smiles` and consults no recogniser at all.
 *
 * 600 is chosen from both ends. Above: it is ~40% below the trap, so no input can reach it. Below:
 * it admits every structure anyone would draw here — paclitaxel is ~110 characters, vancomycin
 * ~200, and the 60-mer peptide `tests/chem.test.tsx` deliberately blesses is 421.
 *
 * **What it does not fix**, stated because the numbers say so rather than left to be discovered: a
 * legal 600-character chain still costs ~0.3 s to parse and ~1.7 s to draw on the main thread, and
 * emits ~300 kB of SVG. Bounding that properly means a worker, which is a change of shape rather
 * than a constant. This bounds the unrecoverable failure, not the slow one.
 *
 * **It is exported because the refusal it causes is not a chemical verdict.** Re-measured against
 * the same binary on 2026-09-05: 600 chars parse and draw (302,187 characters of SVG, 0.6 s), 800
 * do (403,077, 1.3 s), 1,000 do (503,967, 2.4 s), 1,040 parses and the *draw* throws with the
 * runtime still alive, and 1,100 traps and kills it. So every string between 601 and ~1,099
 * characters is a molecule RDKit can read and this module declines to — and a helper that answers
 * `null` for it is saying "not a molecule" about something that is one. That distinction is the
 * same one `rdkitAvailable()` exists for, and it is kept the same way: a cheap predicate the two
 * surfaces that make a claim consult before making it, rather than a third value threaded through
 * every helper.
 */
export const MAX_PARSED_SMILES_CHARS = 600;

/**
 * Is this string past what this module will hand to the parser?
 *
 * A negative from `isMolecule`, `canonicalSmiles` or `moleculeSvg` about such a string is a refusal
 * by this module, not a verdict about the chemistry. Anything about to tell a chemist their string
 * is not a molecule asks this first — see `MAX_PARSED_SMILES_CHARS`.
 */
export function tooLongToParse(smiles: string): boolean {
  return smiles.length > MAX_PARSED_SMILES_CHARS;
}

/**
 * Set when a call has left the WASM runtime dead, so `loadRDKit` stops handing it out.
 *
 * The distinction this exists to keep is the one the trap destroys: `null` from a helper means
 * "not a molecule", which is a claim about the *string*. A dead runtime makes every helper say
 * that about every string, which is a false chemical claim rather than a missing one. Once this is
 * set, `rdkitAvailable()` answers `false` and the surfaces that consult it say the toolkit is
 * unavailable — which is true, and is what they already say when the chunk never arrived.
 */
let poisoned = false;

/** Resolved once, then reused. Only a *success* is cached — see the catch below. */
let modulePromise: Promise<RDKitModule | null> | null = null;

/**
 * The most recent completed attempt ended in a failure, and no new one has started.
 *
 * Not a memoised verdict — `loadRDKit` still starts a fresh attempt for anybody who asks it for a
 * module, which is what keeps a bad first fetch from being permanent. This exists for the *other*
 * question. `rdkitAvailable()` is asked immediately after a helper returned a negative, by a
 * surface deciding which sentence to show, and the surfaces are the two files that make chemical
 * claims. Sending that question through a second full load meant a blackholed `.wasm` cost
 * `TOOLKIT_LOAD_TIMEOUT_MS` to give up drawing and another one to work out *why* — two minutes of
 * empty box before the honest copy appeared. Reading the attempt we just made costs nothing and
 * says the same thing.
 */
let lastAttemptFailed = false;

export function loadRDKit(): Promise<RDKitModule | null> {
  if (poisoned) return Promise.resolve(null);
  const pending = (modulePromise ??= (async () => {
    // A new attempt is under way, so the last one's failure is no longer what `rdkitAvailable`
    // should answer from. Set synchronously, before the first await, so no caller can observe the
    // gap.
    lastAttemptFailed = false;
    try {
      // Bounded, because none of these steps has a deadline of its own: an accepted-and-unanswered
      // request for the 6.9 MB binary leaves this promise pending, and every caller waits on it
      // for the life of the page. `toolkitLoad.ts` carries the reasoning and the number, which the
      // sketcher seam shares.
      return await withLoadTimeout(
        (async () => {
          const [loader, { default: wasmUrl }] = await Promise.all([
            // The package's own typings declare types only — the loader is advertised as a global
            // (`Window.initRDKitModule`) while the shipped file is CommonJS with a default export.
            // So the runtime shape has to be asserted; `RDKitLoader` is the package's own type.
            import('@rdkit/rdkit') as unknown as Promise<{ default: RDKitLoader }>,
            // `?url` keeps the 6.9 MB binary out of the JS bundle and hands us the hashed asset
            // path Vite emitted for it, which is what `locateFile` has to answer with.
            import('@rdkit/rdkit/dist/RDKit_minimal.wasm?url'),
          ]);
          return await loader.default({ locateFile: () => wasmUrl });
        })(),
        'The structure toolkit did not finish loading.',
      );
    } catch {
      // The failure is deliberately **not** memoised, and the timeout is inside that rule rather
      // than an exception to it. A missing `wasm-unsafe-eval`, a chunk that did not arrive, a
      // network blip, a request nobody answered — none of them is a property of the input, and
      // caching the `null` meant one bad first fetch left the page unable to read a structure for
      // its whole lifetime with no retry and nothing on screen to say so. Clearing it here makes
      // the next thing a chemist does try again; a load that times out and lands afterwards is
      // in the browser's cache for that retry.
      modulePromise = null;
      lastAttemptFailed = true;
      return null;
    }
  })());
  return pending;
}

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
 * It reports on the attempt that has already been made rather than commissioning another one, and
 * that is what makes it cheap enough to ask from a render path. A caller that wants a *retry*
 * wants a module, and asks `loadRDKit` for one.
 */
export async function rdkitAvailable(): Promise<boolean> {
  if (lastAttemptFailed && modulePromise === null) return false;
  return (await loadRDKit()) !== null;
}

/**
 * Run `fn` over a parsed molecule, always freeing it.
 *
 * `get_mol` returns `null` for input RDKit cannot read — and throws for some of it, which is why
 * this catches as well as null-checks. Either way the answer is "not a molecule", which is exactly
 * what a recogniser needs to hear.
 */
function withMol<T>(rdkit: RDKitModule, smiles: string, fn: (mol: JSMol) => T): T | null {
  let mol: JSMol | null = null;
  try {
    mol = rdkit.get_mol(smiles);
    if (!mol || !mol.is_valid()) return null;
    return fn(mol);
  } catch {
    // Two very different things arrive here and they used to be answered identically. A C++
    // exception out of the depiction code is ordinary — measured, a 1050-character chain throws
    // one, `delete()` still works and the next molecule parses fine — and "not a molecule" is the
    // right answer for it. A `RuntimeError` out of the WASM is the runtime aborting, after which
    // that answer is a lie about every string. Rather than distinguish them by the shape of the
    // throw, which is Emscripten's business and not a contract, ask the module whether it is still
    // alive.
    if (!stillAlive(rdkit)) poisoned = true;
    return null;
  } finally {
    mol?.delete();
  }
}

/**
 * Can this module still read a molecule at all?
 *
 * `CCO` because it is the shortest thing that exercises the parser and the validity check without
 * being a degenerate single atom. A throw here, or an invalid ethanol, means the heap is gone.
 */
function stillAlive(rdkit: RDKitModule): boolean {
  let probe: JSMol | null = null;
  try {
    probe = rdkit.get_mol('CCO');
    return probe !== null && probe.is_valid();
  } catch {
    return false;
  } finally {
    try {
      probe?.delete();
    } catch {
      // A dead runtime can refuse the free as well. The verdict is already `false`.
    }
  }
}

/**
 * `withMol`, for input that is a SMILES rather than a molblock.
 *
 * The bound is here rather than in `withMol` because a molblock is legitimately long — a
 * thousand-atom `.mol` file is tens of kilobytes of text — and measured, the molfile parser
 * degrades to "invalid" rather than trapping, so it does not need this and would be broken by it.
 *
 * **Re-measured on 2026-09-05, because "the molblock path is unbounded" is a reasonable thing to
 * suspect and the suspicion is what should be tested, not the prose.** V2000 chains fed straight
 * to `get_mol`: 100 atoms (8 kB) and 500 (42 kB) parse; 999 (83 kB) raises a JS
 * `RangeError: Maximum call stack size exceeded` out of the canonical ranking and the runtime is
 * **still alive** afterwards; 1,500 through 50,000 atoms (125 kB → 4.3 MB) return `null` in
 * 3–33 ms, because V2000's counts field is three digits wide and a longer file is malformed by
 * construction. Nothing in that range poisons the heap and nothing takes long enough to freeze a
 * tab, which is what a bound here would be for. There is none, deliberately.
 */
function withSmilesMol<T>(rdkit: RDKitModule, smiles: string, fn: (mol: JSMol) => T): T | null {
  if (smiles.length > MAX_PARSED_SMILES_CHARS) return null;
  return withMol(rdkit, smiles, fn);
}

/**
 * The canonical SMILES for `smiles`, or `null` if it is not a readable molecule.
 *
 * This is the entity key. Two spellings of one molecule must collapse to one string here or the
 * entity rail shows the same compound twice and can never join a computed value to the structure
 * it was computed for.
 */
export async function canonicalSmiles(smiles: string): Promise<string | null> {
  const rdkit = await loadRDKit();
  if (!rdkit) return null;
  return withSmilesMol(rdkit, smiles, (mol) => mol.get_smiles() || null);
}

/** Whether RDKit can read `smiles` as a molecule. The gate a recogniser's guess must pass before
 *  anything is drawn from it. */
export async function isMolecule(smiles: string): Promise<boolean> {
  const rdkit = await loadRDKit();
  if (!rdkit) return false;
  return withSmilesMol(rdkit, smiles, () => true) ?? false;
}

/**
 * The canonical SMILES for an MDL molblock — a `.mol` file's contents, or one record of an `.sdf`.
 *
 * `get_mol` is the same entry point as for SMILES; RDKit sniffs the format. So this is not here to
 * reach a different parser, it is here because **nothing outside this module may hold a `JSMol`**
 * and a component that wanted to read a dropped file would otherwise have to. It also names the
 * intent at the call site, where "is this a molblock or a SMILES" is a question the caller has
 * already answered and the reader should not have to re-derive.
 *
 * The 2D coordinates in the block are deliberately dropped. The entity key and the text inserted
 * into a message are both SMILES, and `moleculeSvg` recomputes a depiction anyway — keeping the
 * drawn coordinates would mean two spellings of one compound again, this time geometric.
 */
export async function canonicalSmilesFromMolblock(molblock: string): Promise<string | null> {
  const rdkit = await loadRDKit();
  if (!rdkit) return null;
  // An empty canvas exported from a sketcher is a syntactically valid molblock with zero atoms,
  // and RDKit reads it happily — as the empty SMILES. That is not a structure, so it fails here
  // rather than being inserted into a message as nothing at all.
  return withMol(rdkit, molblock, (mol) => mol.get_smiles() || null);
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

/** Records parsed between two turns of the event loop. The `await` between records drains
 *  microtasks only, so without a real yield the browser cannot paint for the whole file. */
const YIELD_EVERY = 25;

export async function moleculesFromMolfile(text: string): Promise<MolfileRecords> {
  // Asked once, up front. Without it every record comes back unreadable and the count becomes a
  // claim about the file rather than about the page.
  //
  // The loader rather than `rdkitAvailable`, because this is a gate and not a post-mortem: a
  // chemist dropping a file after an earlier load failed is exactly the retry the catch above
  // exists to allow, and `rdkitAvailable` deliberately answers from the last attempt instead of
  // making one.
  if ((await loadRDKit()) === null) {
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

/**
 * There was a `highlightSmarts` option here, with a `get_substruct_matches` helper behind it, for
 * drawing a hazard flag's motif lit up on the structure it fired on. It is gone because nothing
 * can supply the pattern: `HazardFlag.matched` is *the input the rule fired on* — a SMILES, or
 * `"a + b"` for a pair rule — while the rule's SMARTS stays in the safety connector's own
 * `rules.yaml` and never crosses the wire, and `GenotoxAlert.motif` is a chemist's name for the
 * motif ("aromatic nitro") rather than a pattern. `substructure_matches` *is* given a query, but
 * `ResultSheet` renders its hits as a list and asks for no highlight. Twenty lines to write again
 * on the day the backend echoes a `smarts` field; a highlight nobody can ask for is dead code that
 * looks like a feature.
 */
export interface DrawOptions {
  width: number;
  height: number;
  /** Draw dark-theme colours. RDKit takes this as a drawing option rather than something CSS can
   *  reach, because the SVG's strokes carry explicit colours. */
  dark?: boolean;
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
 * Coordinates come from RDKit's own depiction, normalized and straightened — without those two
 * calls a molecule from a SMILES string with no 2D block is laid out correctly but sits at an
 * arbitrary rotation, and the same compound drawn in two cards can look like two compounds.
 */
export async function moleculeSvg(smiles: string, opts: DrawOptions): Promise<string | null> {
  const key = svgKey(smiles, opts);
  const hit = svgCache.get(key);
  if (hit !== undefined) {
    // Re-inserted, which is what makes the eviction order above least-recently-used. Answered
    // before the loader is consulted on purpose: a drawing already made is a correct drawing of
    // that molecule whatever has happened to the runtime since, and withholding it because the
    // heap has died would replace a picture with a fallback for no gain.
    svgCache.delete(key);
    svgCache.set(key, hit);
    return hit;
  }

  // A drawing already under way is joined rather than started again. The cache above only helps
  // once a draw has *finished*, and the case this application actually produces is the other one:
  // one compound in the rail, the answer and a result card mounts three effects in the same tick,
  // all three miss, and all three block the main thread on the same WASM depiction — 9.71 ms each
  // for atorvastatin, of which two are pure waste. Keyed on the same four inputs as the cache, so
  // two sizes or two themes of one structure are still two drawings.
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

/** Draws in progress, so concurrent callers for one key share one WASM call. */
const inFlight = new Map<string, Promise<string | null>>();

/** One depiction, from the loader to the cache. Split out of `moleculeSvg` so the in-flight table
 *  above holds a promise that is already running before any caller awaits it. */
async function drawOnce(key: string, smiles: string, opts: DrawOptions): Promise<string | null> {
  const rdkit = await loadRDKit();
  if (!rdkit) return null;

  const drawn = withSmilesMol(rdkit, smiles, (mol) => {
    mol.normalize_depiction(1);
    mol.straighten_depiction();

    const details: Record<string, unknown> = {
      width: opts.width,
      height: opts.height,
      // Transparent, so one drawing works on the surface, the sunken surface and inside a sheet
      // without the card behind it showing through a white rectangle.
      backgroundColour: [0, 0, 0, 0],
      ...(opts.dark ? { legendColour: [0.85, 0.85, 0.85], symbolColour: [0.85, 0.85, 0.85] } : {}),
    };

    return mol.get_svg_with_highlights(JSON.stringify(details)) || null;
  });

  // Only a drawing is kept. A `null` here is one of three different things — not a molecule, past
  // the length cap, or a runtime that has just died under `withSmilesMol` — and only the first is
  // a property of the input. Caching the other two would be the memoised-failure defect the loader
  // above refuses, one layer up.
  if (drawn !== null) remember(key, drawn);
  return drawn;
}
