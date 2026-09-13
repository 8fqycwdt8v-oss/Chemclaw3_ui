/**
 * RDKit itself: the WASM module, and every call that touches it.
 *
 * **This is the half that runs off the main thread.** It was all one file until W28.7 measured
 * what a legal 600-character chain costs where it used to run — in real Chromium, through the
 * app's own module, **587 ms of blocked main thread to draw one**, a single `longtask` with the
 * frame loop stopped for its whole duration. Run it rather than reading it:
 * `node scripts/measure-rdkit-placement.mjs`, which is where every figure in this change comes
 * from and the reason none of them is transcribed twice. The 600-character cap above
 * bounds the *unrecoverable* failure (`MAX_PARSED_SMILES_CHARS`) and could never bound that one,
 * because the cost is not a bug to be fixed — parsing and depicting a 300-bond chain is work.
 * Work that blocks a chemist's tab is a placement problem, so the work moved.
 *
 * So this module is deliberately **transport-free and DOM-free**: it imports no React, reads no
 * `document`, and every export takes and returns values a `postMessage` can carry. That is what
 * lets `rdkit.worker.ts` be three lines of dispatch over it, and what lets `rdkit.ts` call the
 * very same functions in-process when a browser has no `Worker` — one implementation, two
 * placements, rather than two implementations that will disagree about some string nobody has
 * typed yet.
 *
 * `src/chem/rdkit.ts` is the seam every caller uses and carries the rest of the argument: why
 * RDKit at all, what the drawing cache is for, and why nothing outside these two files may hold a
 * `JSMol`.
 *
 * **Every JSMol must be deleted.** They are C++ objects behind an Emscripten heap pointer, not
 * garbage-collected values, so a forgotten one leaks for the life of whichever thread owns the
 * heap. Nothing here returns one; each helper owns its handles and frees them in a `finally`.
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

function loadRDKit(): Promise<RDKitModule | null> {
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
  } catch (error) {
    // **A stack exhaustion is a fact about this thread, not about this molecule**, and on a worker
    // there is a thread that can do better. RDKit's canonical ranking recurses over the molecule,
    // so a long chain needs stack proportional to its length, and a worker's is smaller than the
    // page's: measured in Chromium through this module, `C`*400 canonicalises on both and `C`*500
    // canonicalises only on the page. Swallowing that into `null` is the one answer that must not
    // be given — it is "that is not a molecule" about a chain the very next call draws — so it is
    // rethrown, the worker reports it as a failure, and `rdkit.client.ts` runs the same call on
    // the page. In-process there is no better placement, so it stays `null` there: that is the
    // 999-atom molblock this module's `withSmilesMol` docstring already records.
    if (error instanceof RangeError && OFF_MAIN_THREAD) throw error;
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
 * Is this copy of the engine running on a worker thread?
 *
 * The one thing this module knows about its own placement, and it earns that exception because a
 * thread's stack size is a property of the thread. It decides one thing only: whether a stack
 * exhaustion is worth escalating (there is a page with a bigger stack to escalate to) or is the
 * end of the line.
 *
 * A `typeof` off `globalThis` rather than `self instanceof WorkerGlobalScope`, because the name is
 * declared in TypeScript's `webworker` lib and this project builds against `dom` — and the two
 * libs cannot both be referenced from one file. `WorkerGlobalScope` is exposed as a global only in
 * a worker, which is exactly the question. Not `'WorkerGlobalScope' in globalThis`: a property
 * that exists and holds `undefined` satisfies `in`, so that spelling reads a page as a worker the
 * moment anything assigns the name — which is exactly what a test stubbing globals does.
 */
const OFF_MAIN_THREAD =
  typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined';

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
 * `smiles` drawn as an SVG, or `null` if it is not a molecule.
 *
 * Coordinates come from RDKit's own depiction, normalized and straightened — without those two
 * calls a molecule from a SMILES string with no 2D block is laid out correctly but sits at an
 * arbitrary rotation, and the same compound drawn in two cards can look like two compounds.
 *
 * Uncached, deliberately: the cache belongs on the calling thread, where a hit costs nothing at
 * all rather than a round trip. See `moleculeSvg` in `rdkit.ts`.
 */
export async function drawSvg(smiles: string, opts: DrawOptions): Promise<string | null> {
  const rdkit = await loadRDKit();
  if (!rdkit) return null;

  return withSmilesMol(rdkit, smiles, (mol) => {
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
}

/**
 * Did the toolkit load?
 *
 * `loadRDKit` is not exported — nothing outside this module may hold an `RDKitModule` any more
 * than it may hold a `JSMol`, and across a worker boundary it could not anyway. What a caller
 * legitimately wants to know before reading a file full of records is whether there is a toolkit
 * at all, and that is a boolean. Unlike `rdkitAvailable` this *commissions* an attempt: it is a
 * gate in front of work, not a post-mortem after it.
 */
export async function toolkitLoads(): Promise<boolean> {
  return (await loadRDKit()) !== null;
}

/**
 * Every engine call, by name — the one registry both placements read.
 *
 * `rdkit.worker.ts` dispatches a message through it and `rdkit.client.ts` calls it directly when
 * there is no worker to send to, so "what the engine can be asked" has a single definition. A
 * second table would be two lists that must agree, and the way that fails is the quiet one: an
 * operation added to the worker and forgotten in the fallback answers correctly in Chrome and
 * throws in whatever browser took the other path.
 *
 * `rdkit.protocol.ts` derives the wire types from this, so adding a row here is the whole change.
 */
export const operations = {
  available: rdkitAvailable,
  toolkitLoads,
  canonicalSmiles,
  isMolecule,
  canonicalSmilesFromMolblock,
  drawSvg,
} as const;
