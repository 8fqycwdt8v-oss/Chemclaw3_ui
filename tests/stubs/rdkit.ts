/**
 * A stand-in for the RDKit WASM module, aliased over `@rdkit/rdkit` in `vitest.config.ts`.
 *
 * The real binary is 6.9 MB of WebAssembly that expects to fetch a `.wasm` sibling over HTTP.
 * Under happy-dom it aborts on the missing file — which the loader catches, so the suite would
 * pass either way, but it would pass by exercising the *degraded* path on every test that renders
 * a structure. That is the one path we do not want as the default: it would let a real break in
 * the drawing code look exactly like the environment not having RDKit.
 *
 * So this is deliberately a *behavioural* fake rather than an empty mock. It implements just
 * enough of the interface for the module under test to be meaningful — validity,
 * canonicalisation, and an SVG that names what it drew — and it models the two properties the
 * calling code is built around:
 *
 *  - **Invalid input returns null.** `get_mol` refuses anything that is not in its small
 *    vocabulary, so the "not a structure" branch is reachable in a test.
 *  - **Handles must be deleted.** Every object counts its own `delete()`, and `liveHandles()` lets
 *    a test assert none leaked. Emscripten objects are not garbage-collected, so a forgotten
 *    handle is a real leak for the page's lifetime and nothing else would catch it.
 */

let live = 0;

/** How many stub molecules are currently un-deleted. Zero between tests, or something leaked. */
export const liveHandles = (): number => live;

export const resetHandles = (): void => {
  live = 0;
};

/**
 * The molecules this fake knows, mapped to their canonical form.
 *
 * Two spellings of anisole-with-bromine are both present on purpose: the entity store's whole
 * premise is that they collapse to one key, and a fake that canonicalised by identity could not
 * demonstrate it.
 *
 * The rest are simply every structure the suite draws — including the Suzuki components the
 * pre-existing `structures.test.tsx` uses, which reach `<Molecule>` through the reaction split and
 * would otherwise render as unreadable strings.
 */
const KNOWN: Record<string, string> = {
  CCO: 'CCO',
  OCC: 'CCO',
  'CC(=O)O': 'CC(=O)O',
  'CC(=O)OC': 'CC(=O)OC',
  'CC=O': 'CC=O',
  'COc1ccc(Br)cc1': 'COc1ccc(Br)cc1',
  'BrC1=CC=C(OC)C=C1': 'COc1ccc(Br)cc1',
  c1ccccc1: 'c1ccccc1',
  O: 'O',
  CO: 'CO',
  'COc1ccc(cc1)-c1ccccc1': 'COc1ccc(cc1)-c1ccccc1',
  'OB(O)c1ccccc1': 'OB(O)c1ccccc1',
  'CCOC(C)=O': 'CCOC(C)=O',
  Brc1ccccc1: 'Brc1ccccc1',
  'c1ccc(-c2ccccc2)cc1': 'c1ccc(-c2ccccc2)cc1',
};

/**
 * Molfile support, keyed on **atom composition**.
 *
 * `get_mol` takes a molblock as readily as a SMILES — that is the whole reason the structure input
 * can drop a `.mol` file straight into this module — so the fake has to accept one too, and an
 * empty mock would let a broken molfile path pass every test.
 *
 * What it does is parse the V2000 counts line and the element symbol out of each atom line, and
 * look the resulting formula up here. That keeps it behavioural in the two ways the calling code
 * depends on: a **truncated** block (fewer atom lines than the counts line promises) is refused,
 * which is the case a real screening file produces; and an **empty** canvas — a valid block with
 * zero atoms, which is what a sketcher exports before anything is drawn — reads as the empty
 * SMILES, so the "nothing drawn" branch is reachable.
 *
 * Bonds are ignored. That is a real limit of the fake and it is the reason this maps composition
 * rather than structure: it cannot tell two isomers apart, so no test may depend on it doing so.
 */
const MOLBLOCK_FORMULAE: Record<string, string> = {
  C2O1: 'CCO',
  C2O2: 'CC(=O)O',
  C1O1: 'CO',
  C6: 'c1ccccc1',
  O1: 'O',
  Br1C7O1: 'COc1ccc(Br)cc1',
};

/**
 * The SMILES a molblock stands for, `''` for an empty one, or `null` if this is not a molblock the
 * fake can read.
 */
function molblockSmiles(input: string): string | null {
  const lines = input.split(/\r?\n/);
  // Line 4 is the counts line — **by position, not by search**. The MDL header is four fixed lines
  // (title, program, comment, counts) and the title is routinely *empty*, which is what
  // `MolToMolBlock` and ChemDraw write. Indexing rather than scanning for a `V2000` line anywhere
  // is what makes this fake faithful instead of forgiving: a splitter that eats a blank title line
  // shifts every header line up by one, and only a positional reader notices. Real RDKit does not
  // notice either — it reads the shifted line as counts and returns a wrong molecule or none.
  //
  // `V2000` at the end identifies the dialect. Anything else — a SMILES string, a V3000 block, a
  // CSV someone dropped on the file target — is not ours.
  const counts = lines[3];
  if (!counts || !/V2000\s*$/.test(counts)) return null;

  const atomCount = Number.parseInt(counts.slice(0, 3), 10);
  if (!Number.isInteger(atomCount) || atomCount < 0) return null;
  if (atomCount === 0) return '';

  const tally = new Map<string, number>();
  for (let i = 0; i < atomCount; i += 1) {
    const line = lines[4 + i];
    // The counts line promised an atom that is not there: the file is truncated, and a truncated
    // structure is the failure this whole codebase refuses to render.
    if (!line) return null;
    const symbol = line.slice(31, 34).trim();
    if (!symbol) return null;
    tally.set(symbol, (tally.get(symbol) ?? 0) + 1);
  }

  const formula = [...tally.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([symbol, n]) => `${symbol}${n}`)
    .join('');

  return MOLBLOCK_FORMULAE[formula] ?? null;
}

interface StubMol {
  is_valid(): boolean;
  get_smiles(): string;
  normalize_depiction(canonicalize?: number): number;
  straighten_depiction(): void;
  get_svg_with_highlights(details: string): string;
  delete(): void;
}

function makeMol(smiles: string): StubMol {
  live += 1;
  let deleted = false;
  return {
    is_valid: () => true,
    get_smiles: () => KNOWN[smiles] ?? smiles,
    normalize_depiction: () => 1,
    straighten_depiction: () => undefined,
    get_svg_with_highlights(details: string) {
      const parsed = JSON.parse(details) as { width?: number };
      // The canonical form, so a test can assert *which* molecule was drawn rather than only that
      // something was.
      return `<svg data-smiles="${KNOWN[smiles] ?? smiles}" data-width="${parsed.width ?? 0}"></svg>`;
    },
    delete() {
      if (deleted) return;
      deleted = true;
      live -= 1;
    },
  };
}

const rdkitModule = {
  get_mol(input: string): StubMol | null {
    if (input in KNOWN) return makeMol(input);
    const fromMolblock = molblockSmiles(input);
    // `''` is a real answer here — a molblock with no atoms — and it must produce a *handle* whose
    // SMILES is empty rather than a null. The caller's `get_smiles() || null` is what turns it into
    // "not a structure", and routing it through the handle is what proves that handle gets freed.
    return fromMolblock === null ? null : makeMol(fromMolblock);
  },
  version: () => 'stub',
};

/** Matches the real package's shape: a default export that resolves to the module. */
export default async function initRDKitModule(): Promise<typeof rdkitModule> {
  return rdkitModule;
}
