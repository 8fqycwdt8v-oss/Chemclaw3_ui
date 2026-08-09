/**
 * A stand-in for the RDKit WASM module, aliased over `@rdkit/rdkit` in `vitest.config.ts`.
 *
 * The real binary is 6.9 MB of WebAssembly that expects to fetch a `.wasm` sibling over HTTP.
 * Under happy-dom it aborts on the missing file — which the loader catches, so the suite passed
 * either way, but it passed by exercising the *degraded* path on every test that renders a
 * structure. That is the one path we do not want as the default: it would let a real break in the
 * drawing code look exactly like the environment not having RDKit.
 *
 * So this is deliberately a *behavioural* fake rather than an empty mock. It implements just enough
 * of the interface for the module under test to be meaningful — validity, canonicalisation,
 * substructure matching, and an SVG that names what it drew — and it models the two properties the
 * calling code is built around:
 *
 *  - **Invalid input returns null.** `get_mol` refuses anything that is not in its small vocabulary,
 *    so the "not a structure" branch is reachable in a test.
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
 */
const KNOWN: Record<string, string> = {
  CCO: 'CCO',
  'OCC': 'CCO',
  'CC(=O)O': 'CC(=O)O',
  'COc1ccc(Br)cc1': 'COc1ccc(Br)cc1',
  'BrC1=CC=C(OC)C=C1': 'COc1ccc(Br)cc1',
  'c1ccccc1': 'c1ccccc1',
  'O': 'O',
  'CC(=O)OC': 'CC(=O)OC',
  'CO': 'CO',
  'COc1ccc(cc1)-c1ccccc1': 'COc1ccc(cc1)-c1ccccc1',
  'OB(O)c1ccccc1': 'OB(O)c1ccccc1',
  'CCOC(C)=O': 'CCOC(C)=O',
};

/** SMARTS the fake can answer substructure questions about, and which molecules they hit. */
const SMARTS_HITS: Record<string, string[]> = {
  '[Br]': ['COc1ccc(Br)cc1'],
  'c1ccccc1': ['c1ccccc1', 'COc1ccc(Br)cc1', 'COc1ccc(cc1)-c1ccccc1', 'OB(O)c1ccccc1'],
  '[N+](=O)[O-]': [],
};

interface StubMol {
  __smiles: string;
  __isQuery: boolean;
  is_valid(): boolean;
  get_smiles(): string;
  normalize_depiction(canonicalize?: number): number;
  straighten_depiction(): void;
  get_svg_with_highlights(details: string): string;
  get_substruct_matches(query: StubMol): string;
  delete(): void;
}

function makeMol(smiles: string, isQuery: boolean): StubMol {
  live += 1;
  let deleted = false;
  return {
    __smiles: smiles,
    __isQuery: isQuery,
    is_valid: () => true,
    get_smiles: () => KNOWN[smiles] ?? smiles,
    normalize_depiction: () => 1,
    straighten_depiction: () => undefined,
    get_svg_with_highlights(details: string) {
      const parsed = JSON.parse(details) as { atoms?: number[]; width?: number };
      const highlighted = (parsed.atoms ?? []).length;
      // The canonical form, so a test can assert *which* molecule was drawn rather than only that
      // something was.
      return `<svg data-smiles="${KNOWN[smiles] ?? smiles}" data-highlighted="${highlighted}"></svg>`;
    },
    get_substruct_matches(query: StubMol) {
      const hits = SMARTS_HITS[query.__smiles];
      if (!hits || !hits.includes(smiles)) return '';
      return JSON.stringify([{ atoms: [0, 1], bonds: [0] }]);
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
    return input in KNOWN ? makeMol(input, false) : null;
  },
  get_qmol(input: string): StubMol | null {
    return input in SMARTS_HITS ? makeMol(input, true) : null;
  },
  version: () => 'stub',
};

/** Matches the real package's shape: a default export that resolves to the module. */
export default async function initRDKitModule(): Promise<typeof rdkitModule> {
  return rdkitModule;
}
