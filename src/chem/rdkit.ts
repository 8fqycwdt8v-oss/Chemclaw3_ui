/**
 * RDKit, loaded into the browser.
 *
 * This replaces `smiles-drawer`, and the trade it reverses is worth restating because the old
 * choice was right for what the UI then did. smiles-drawer is pure JS, ~190 kB, and draws a SMILES
 * string to SVG with no initialisation — ideal when the only structure on screen came from one
 * field of one job payload. RDKit is a ~6.9 MB WASM binary behind an async handshake, and it buys
 * three things that file's own docstring named as the day it would be justified:
 *
 *  - **Canonical identity.** `COc1ccc(Br)cc1` and `BrC1=CC=C(OC)C=C1` are the same molecule and
 *    different strings. Anything that collects the molecules of a conversation needs them to be
 *    one entity, and no amount of string handling gets there.
 *  - **Substructure highlighting.** `substructure_matches` is *given* a SMARTS query, so the pattern
 *    is in the turn's own tool arguments and every hit can be drawn with the queried motif lit up.
 *
 *    This paragraph used to claim the safety connector returns the SMARTS motif each hazard flag
 *    matched. It does not, and the mistake is worth leaving recorded because it is an easy one to
 *    repeat from the field name alone: `HazardFlag.matched` is *the input the rule fired on* — a
 *    SMILES, or `"a + b"` for a pair rule — while the rule's pattern stays in the connector's own
 *    `rules.yaml` and never crosses the wire. `GenotoxAlert.motif` is a chemist's name for the
 *    motif ("aromatic nitro"), not a pattern either. So a hazard card can redraw the structure that
 *    fired, and cannot yet show where on it. `CitedFlags` probes for a `smarts` field anyway, so
 *    the highlight appears the day the backend echoes one.
 *  - **Validation.** A recogniser that guesses at SMILES-shaped text is only safe if something can
 *    say "that is not a molecule" before it is drawn.
 *
 * **Loaded lazily and once.** The module promise is cached here, so the WASM is fetched the first
 * time a structure actually appears and never again. A page that shows no chemistry pays nothing.
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

/** Resolved once, then reused. `null` once loading has failed, so a broken WASM fetch degrades to
 *  "no structures" rather than retrying on every render. */
let modulePromise: Promise<RDKitModule | null> | null = null;

export function loadRDKit(): Promise<RDKitModule | null> {
  modulePromise ??= (async () => {
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
      return null;
    }
  })();
  return modulePromise;
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
}

export async function moleculesFromMolfile(text: string): Promise<MolfileRecords> {
  const records = splitSdfRecords(text);
  const smiles: string[] = [];
  let unreadable = 0;

  for (const record of records) {
    const canonical = await canonicalSmilesFromMolblock(record);
    if (canonical) smiles.push(canonical);
    else unreadable += 1;
  }

  return { smiles, unreadable };
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

export interface DrawOptions {
  width: number;
  height: number;
  /** Draw dark-theme colours. RDKit takes this as a drawing option rather than something CSS can
   *  reach, because the SVG's strokes carry explicit colours. */
  dark?: boolean;
  /** A SMARTS pattern whose matches are highlighted — the motif a hazard flag fired on. Ignored
   *  if it is not a readable query, because a highlight nobody asked for is better lost than a
   *  structure. */
  highlightSmarts?: string;
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
      backgroundColour: [0, 0, 0, 0],
      ...(opts.dark
        ? { legendColour: [0.85, 0.85, 0.85], symbolColour: [0.85, 0.85, 0.85] }
        : {}),
    };

    if (opts.highlightSmarts) {
      const matched = matchAtoms(rdkit, mol, opts.highlightSmarts);
      if (matched) {
        details.atoms = matched.atoms;
        details.bonds = matched.bonds;
      }
    }

    return mol.get_svg_with_highlights(JSON.stringify(details)) || null;
  });
}

/**
 * The atom and bond indices in `mol` matching the SMARTS `pattern`.
 *
 * Every match, not the first: a motif that occurs twice is flagged twice, and highlighting one
 * occurrence would understate what the screen actually matched.
 */
function matchAtoms(
  rdkit: RDKitModule,
  mol: JSMol,
  pattern: string,
): { atoms: number[]; bonds: number[] } | null {
  let query: JSMol | null = null;
  try {
    query = rdkit.get_qmol(pattern);
    if (!query || !query.is_valid()) return null;
    const raw = mol.get_substruct_matches(query);
    if (!raw) return null;
    const matches = JSON.parse(raw) as { atoms?: number[]; bonds?: number[] }[];
    if (!Array.isArray(matches) || matches.length === 0) return null;
    return {
      atoms: [...new Set(matches.flatMap((m) => m.atoms ?? []))],
      bonds: [...new Set(matches.flatMap((m) => m.bonds ?? []))],
    };
  } catch {
    return null;
  } finally {
    query?.delete();
  }
}

/**
 * A reaction SMILES split into the parts a renderer draws either side of the arrow.
 *
 * RDKit's *minimal* build ships no reaction object, so this is composed from the components rather
 * than handed to a reaction drawer: split on `>`, then split each side on `.`. That is exactly the
 * reaction SMILES grammar — `reactants>agents>products` — and it is enough, because what a chemist
 * needs from the picture is which structures went in and which came out.
 *
 * Returns `null` for anything that is not a reaction, including a plain molecule, so a caller can
 * use it as the discriminator.
 */
export interface ParsedReaction {
  reactants: string[];
  agents: string[];
  products: string[];
}

export function parseReactionSmiles(text: string): ParsedReaction | null {
  const trimmed = text.trim();
  if (!trimmed.includes('>')) return null;

  const parts = trimmed.split('>');
  // Exactly two arrows. `A>>B` gives three parts with an empty middle; `A>B>C` gives three with a
  // populated one. Anything else is not a reaction SMILES.
  if (parts.length !== 3) return null;

  const split = (side: string | undefined): string[] =>
    (side ?? '')
      .split('.')
      .map((s) => s.trim())
      .filter(Boolean);

  const reactants = split(parts[0]);
  const products = split(parts[2]);
  // A reaction with nothing on one side is a string containing an arrow, not a transformation.
  if (reactants.length === 0 || products.length === 0) return null;

  return { reactants, agents: split(parts[1]), products };
}
