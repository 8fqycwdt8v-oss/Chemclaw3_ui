/**
 * Finding chemistry in text.
 *
 * Deliberately **syntactic only** — no RDKit import, no async, no WASM. These are cheap guesses
 * that say "this token has the shape of a molecule / a reaction / a calculation reference", and
 * they are wrong often enough that nothing may be drawn on their say-so alone. `src/chem/rdkit.ts`
 * is the arbiter: the recogniser proposes, RDKit disposes.
 *
 * Keeping the two apart is what makes this file testable without a 6.9 MB binary, and it is also
 * the honest division of labour — "does this look like a SMILES" and "is this a molecule" are
 * different questions and only the second one has a real answer.
 *
 * ## The rule that matters
 *
 * **Never run these over `tool_result.preview`.** The service truncates it to 200 characters at an
 * arbitrary byte, and a SMILES string cut short very often remains *valid* — as a smaller,
 * different molecule. Prose cut short reads as cut short; a structure cut short reads as a
 * structure, and there is nothing downstream that can catch it. Sources that are safe: a
 * `tool_call.arguments` document that parses as whole JSON, a stored transcript's arguments, note
 * frontmatter, and answer text.
 */

/**
 * Letters that can appear in a SMILES string *outside* square brackets.
 *
 * The organic subset — B, C, N, O, P, S, F, I and the aromatic lowercase forms — plus `l` and `r`
 * for the second letter of `Cl` and `Br`, and `H` for hydrogen counts. Inside brackets any element
 * symbol is legal, which is why the check below only applies when there are no brackets.
 */
const BARE_SMILES_LETTERS = /^[BCNOPSFIHbcnopslr]+$/;

/**
 * Does this look like a SMILES string?
 *
 * Conservative, because chemistry prose is full of tokens that superficially resemble SMILES
 * (`pH`, `NMR`, `DMSO`, unit strings) and offering to render something that is not a molecule is
 * worse than not offering at all.
 *
 * **But not the way it used to be.** The previous rule demanded a bracket, a digit or a bond
 * character, on the theory that plain words would otherwise pass — and that rejected `CCO`. Ethanol
 * is not an edge case, and neither are `CC`, `CCN` or any other straight-chain molecule a chemist
 * writes a dozen times a day: none of them contains a structural character, so none of them was
 * ever offered a structure. The test that catches this is the first assertion in `chem.test.tsx`.
 *
 * The rule that replaces it asks the real question — could every letter here be a SMILES atom? —
 * which rejects `the`, `NMR` and `DMSO` on their `t`, `M` and `D` while accepting `CCO`. It is
 * looser overall, and that is affordable now in a way it was not before: RDKit is the arbiter, so
 * a false positive costs a parse that returns null, not a wrong structure on screen.
 */
export function looksLikeSmiles(text: string): boolean {
  const s = text.trim();
  // Three, not four: `CCO` is three characters. Below that, `NO` and `CO` collide with ordinary
  // prose far too often to be worth the one real molecule they would catch.
  if (s.length < 3 || s.length > 400) return false;
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
 * Does this look like a **compound name** rather than a structure?
 *
 * Asked only after RDKit has already refused the string, and used for one thing: to tell a chemist
 * who typed `4-bromoanisole` into a SMILES box why nothing was drawn. "Not a valid structure" is
 * true and useless there; "a name is not a structure" is the actual answer.
 *
 * The backend *can* do this conversion — `resolve_compound` in the `chem` connector is RDKit plus a
 * vendored dataset — but it is an agent tool with no HTTP route, reachable only inside a turn. So
 * this function exists to produce a sentence, not a lookup. Inventing an endpoint, or shipping a
 * name table to the browser, would both be worse than saying what is true.
 *
 * The test is deliberately narrow, because a wrong guess here is a confident wrong explanation:
 * structural punctuation disqualifies (a name has no `()[]=#@`), and there must be a run of at
 * least three letters containing something the bare organic subset does not allow — the `m` and `a`
 * of `bromoanisole`, the `e` and `z` of `benzene`. A malformed SMILES made only of legal atom
 * letters gets the plain "not a structure" message instead, which is the right way for this to be
 * wrong.
 */
export function looksLikeCompoundName(text: string): boolean {
  const s = text.trim();
  if (s.length < 3 || s.length > 200) return false;
  if (looksLikeSmiles(s) || looksLikeReactionSmiles(s)) return false;
  if (/[()[\]=#@$*\\/]/.test(s)) return false;
  return (s.match(/[A-Za-z]{3,}/g) ?? []).some((run) => !BARE_SMILES_LETTERS.test(run));
}

/**
 * Does this look like a reaction SMILES?
 *
 * The grammar is `reactants>agents>products`, so the marker is two `>` characters with something
 * molecule-shaped on both ends. Checked before `looksLikeSmiles`, which rejects nothing containing
 * `>` only because `>` is not in its character class — the two must not disagree about a string.
 */
export function looksLikeReactionSmiles(text: string): boolean {
  const s = text.trim();
  if (s.length > 800) return false;
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
 * A calculation reference — `type@version:hash:hash`.
 *
 * The same shape the backend validates note frontmatter against (`kg/note.py`), and the handle
 * `list_artifacts` and `fetch_artifact` take. Distinctive enough to match on sight, which makes it
 * the one identifier here with no false-positive problem.
 */
const CALC_REF = /^[^\s@:]+@[^\s:]+:[0-9a-f]+:[0-9a-f]+$/;

export const isCalcRef = (text: string): boolean => CALC_REF.test(text.trim());

/**
 * Note-id prefixes this system actually mints.
 *
 * Taken from the knowledge corpus rather than from the note-type vocabulary, because the two do
 * not match: a note of type `reaction` has an id beginning `rxn-`, and `optimization-campaign`
 * becomes `opt-`. The previous list here was `reaction-`, `note-` and `qm-`, of which the first
 * two match **nothing** the backend has ever written — so citation chips were firing on almost no
 * real citation.
 *
 * This is still a heuristic over prose, and it is now the **fallback** rather than the mechanism.
 * `remarkCitations` uses `tool_result.note_ids` — the service's exact, untruncated answer to which
 * notes a turn actually saw — wherever the turn has them, and reaches here only when it does not:
 * an older backend, or a turn that called no tools. It is also what `NoteView` renders a stored
 * note body with, where there is no turn behind the text at all.
 *
 * Worth keeping in view when reading a chip: under the authoritative list a note-shaped token the
 * turn did not return gets no chip, which is the point. Under this fallback it gets one on the
 * strength of its prefix alone.
 */
const NOTE_PREFIXES = [
  'compound',
  'rxn',
  'playbook',
  'interaction',
  'campaign',
  'opt',
  'report',
  'failure',
  'proposal',
  'bo-candidate',
  'job-result',
] as const;

/** Durable job ids, which are minted by the workflow rather than authored — `qm-<hash>` and the
 *  other connectors' equivalents. */
const JOB_ID = /^(qm|calc|bo|report)-[A-Za-z0-9]{4,64}$/;

export const isJobId = (text: string): boolean => JOB_ID.test(text.trim());

/** Whether `text` has the shape of a knowledge-graph note id. */
export function looksLikeNoteId(text: string): boolean {
  const s = text.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s)) return false;
  return NOTE_PREFIXES.some((prefix) => s.startsWith(`${prefix}-`) && s.length > prefix.length + 1);
}

/** The regex source for note-shaped tokens, for the remark plugin that linkifies them in prose. */
export const NOTE_ID_PATTERN = new RegExp(
  `\\b(?:${NOTE_PREFIXES.join('|')})-[A-Za-z0-9][A-Za-z0-9_.-]*\\b`,
  'g',
);

/** The regex source for job ids in prose. */
export const JOB_ID_PATTERN = /\b(?:qm|calc|bo|report)-[A-Za-z0-9]{4,64}\b/g;

/**
 * Pull the SMILES-shaped values out of a tool call's arguments.
 *
 * Only from a document that parses as whole JSON — which is exactly the boundary the backend
 * announces a call on, so a complete `tool_call.arguments` is the normal case and a truncated one
 * is visibly not JSON. That check is what makes this safe where scanning the preview is not.
 *
 * Keys are not filtered by name. Every molecule-taking tool in the surface uses `smiles`, but
 * `compute_reaction_energy` takes `reactants`/`products` arrays, `compare_solvents` takes
 * `solvents`, and a value that looks like a molecule under any key is one the turn was working on.
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
