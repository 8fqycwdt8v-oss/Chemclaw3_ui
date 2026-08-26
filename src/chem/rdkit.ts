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
 * fetched the first time a structure appears. (The entry ends this branch at 509 kB. That
 * difference is the application code added on top — the method/caveat table, the entity store and
 * rail, the structure input — and none of it is RDKit or Ketcher: the only mention of either in
 * the entry chunk is the dynamic-import reference to their chunks.)
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

/** Resolved once, then reused. Only a *success* is cached — see the catch below. */
let modulePromise: Promise<RDKitModule | null> | null = null;

export function loadRDKit(): Promise<RDKitModule | null> {
  const pending = (modulePromise ??= (async () => {
    try {
      const [loader, { default: wasmUrl }] = await Promise.all([
        // The package's own typings declare types only — the loader is advertised as a global
        // (`Window.initRDKitModule`) while the shipped file is CommonJS with a default export. So
        // the runtime shape has to be asserted; `RDKitLoader` is the package's own type for it.
        import('@rdkit/rdkit') as unknown as Promise<{ default: RDKitLoader }>,
        // `?url` keeps the 6.9 MB binary out of the JS bundle and hands us the hashed asset path
        // Vite emitted for it, which is what `locateFile` has to answer with.
        import('@rdkit/rdkit/dist/RDKit_minimal.wasm?url'),
      ]);
      return await loader.default({ locateFile: () => wasmUrl });
    } catch {
      // The failure is deliberately **not** memoised. A missing `wasm-unsafe-eval`, a chunk that
      // did not arrive, a network blip — none of them is a property of the input, and caching the
      // `null` meant one bad first fetch left the page unable to read a structure for its whole
      // lifetime with no retry and nothing on screen to say so. Clearing it here makes the next
      // thing a chemist does try again.
      modulePromise = null;
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
 */
export async function rdkitAvailable(): Promise<boolean> {
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
    return null;
  } finally {
    mol?.delete();
  }
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
  return withMol(rdkit, smiles, (mol) => mol.get_smiles() || null);
}

/** Whether RDKit can read `smiles` as a molecule. The gate a recogniser's guess must pass before
 *  anything is drawn from it. */
export async function isMolecule(smiles: string): Promise<boolean> {
  const rdkit = await loadRDKit();
  if (!rdkit) return false;
  return withMol(rdkit, smiles, () => true) ?? false;
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
  if (!(await rdkitAvailable())) {
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
 * `smiles` drawn as an SVG, or `null` if it is not a molecule.
 *
 * Coordinates come from RDKit's own depiction, normalized and straightened — without those two
 * calls a molecule from a SMILES string with no 2D block is laid out correctly but sits at an
 * arbitrary rotation, and the same compound drawn in two cards can look like two compounds.
 */
export async function moleculeSvg(smiles: string, opts: DrawOptions): Promise<string | null> {
  const rdkit = await loadRDKit();
  if (!rdkit) return null;

  return withMol(rdkit, smiles, (mol) => {
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
