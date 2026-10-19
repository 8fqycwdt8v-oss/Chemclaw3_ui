/**
 * Finding chemistry in text — syntactic only (no RDKit, no async). These are cheap guesses;
 * `src/chem/rdkit.ts` decides. The recogniser proposes, RDKit disposes.
 *
 * Never run these over `tool_result.preview`: it is cut at an arbitrary byte, and a truncated
 * SMILES is often still valid as a different molecule. Safe sources: whole-JSON
 * `tool_call.arguments`, stored arguments, answer text. Note and job ids are
 * `src/lib/citations.ts`'s concern.
 */

/**
 * Letters allowed in a SMILES outside brackets: the organic subset (and aromatic forms), `l`/`r`
 * for `Cl`/`Br`, and `H`.
 */
const BARE_SMILES_LETTERS = /^[BCNOPSFIHbcnopslr]+$/;

/**
 * The longest string worth guessing about — a cost bound far above anything a chemist writes (a
 * 60-residue peptide is 421 characters).
 */
const MAX_SMILES_CHARS = 4000;

/** The same bound for a reaction, which is several molecules plus an agents field. */
const MAX_REACTION_CHARS = 3 * MAX_SMILES_CHARS;

/**
 * Whether this looks like a SMILES string: every letter must be a possible SMILES atom, which
 * rejects `the`, `NMR`, `DMSO` and accepts `CCO` (`tests/chem.test.tsx`). False positives cost only
 * an RDKit parse.
 */
export function looksLikeSmiles(text: string): boolean {
  const s = text.trim();
  // Three, not four: `CCO` is three characters. Below that, `NO` and `CO` collide with ordinary
  // prose far too often to be worth the one real molecule they would catch.
  if (s.length < 3 || s.length > MAX_SMILES_CHARS) return false;
  if (/\s/.test(s)) return false;
  if (!/^[A-Za-z0-9@+\-[\]()=#$%/\\.*]+$/.test(s)) return false;
  // Must contain an atom from the organic subset at all.
  if (!/[BCNOPSFIbcnops]/.test(s)) return false;
  // With no brackets, every letter must be one SMILES allows bare. With brackets, any element
  // symbol is legal inside them, so this cannot be checked without parsing — which is RDKit's job.
  if (!s.includes('[')) {
    const letters = s.replace(/[^A-Za-z]/g, '');
    if (letters && !BARE_SMILES_LETTERS.test(letters)) return false;
  }
  return true;
}

/**
 * Whether this looks like a compound name, asked only after RDKit refused the string, to explain
 * why nothing was drawn ("a name is not a structure"). Narrow on purpose: no structural
 * punctuation, and a run of three or more letters including ones the organic subset does not allow.
 */
export function looksLikeCompoundName(text: string): boolean {
  const s = text.trim();
  if (s.length < 3 || s.length > 200) return false;
  if (looksLikeSmiles(s) || looksLikeReactionSmiles(s)) return false;
  if (/[()[\]=#@$*\\/]/.test(s)) return false;
  return (s.match(/[A-Za-z]{3,}/g) ?? []).some((run) => !BARE_SMILES_LETTERS.test(run));
}

/**
 * Whether this looks like a reaction SMILES (`reactants>agents>products`): two `>` with
 * molecule-shaped ends.
 */
export function looksLikeReactionSmiles(text: string): boolean {
  const s = text.trim();
  if (s.length > MAX_REACTION_CHARS) return false;
  if (/\s/.test(s)) return false;
  const parts = s.split('>');
  if (parts.length !== 3) return false;
  const ends = [parts[0] ?? '', parts[2] ?? ''];
  // Every component on both ends must itself look like a molecule. A reaction is not a licence to
  // relax the check that stops arbitrary punctuation being drawn.
  return ends.every((side) => {
    const components = side.split('.').filter(Boolean);
    return components.length > 0 && components.every(looksLikeSmiles);
  });
}

/**
 * Whether this looks like an MDL molblock: line 4 (counts) ends in `V2000`/`V3000`. Used on paste,
 * where a multi-line molblock would otherwise be dropped by the whitespace guard.
 */
export function looksLikeMolblock(text: string): boolean {
  const counts = text.split(/\r?\n/)[3];
  return counts !== undefined && /V[23]000\s*$/.test(counts);
}

/**
 * SMILES-shaped values from a tool call's arguments, only when they parse as whole JSON. Any key,
 * since tools name molecule arguments differently.
 */
export function smilesFromArguments(argumentsJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    // Not a complete document: either still streaming, or truncated. Either way, off limits.
    return [];
  }

  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (looksLikeSmiles(value) || looksLikeReactionSmiles(value)) found.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  walk(parsed);

  return [...new Set(found)];
}
