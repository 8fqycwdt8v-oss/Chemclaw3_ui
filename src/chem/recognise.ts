/**
 * Finding chemistry in text.
 *
 * Deliberately **syntactic only** — no RDKit import, no async, no WASM. These are cheap guesses
 * that say "this token has the shape of a molecule / a reaction / a compound name", and they are
 * wrong often enough that nothing may be drawn on their say-so alone. `src/chem/rdkit.ts` is the
 * arbiter: the recogniser proposes, RDKit disposes.
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
 * `tool_call.arguments` document that parses as whole JSON, a stored transcript's arguments, and
 * answer text.
 *
 * ## What deliberately is not here
 *
 * There is no note-id or job-id recogniser. `src/lib/citations.ts` owns which prose tokens become
 * chips, and its prefixes are the ones the service was observed to mint — `GET /notes/{id}` and
 * the BFF's `note-{slug}` route pattern (`server/routes.ts`) both exist because a `note-…` id is
 * what the knowledge graph actually hands out. A second, differently-spelled list of prefixes in
 * this file would be a rule with two spellings, of which the unused one is free to drift.
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
 * The longest string worth guessing about.
 *
 * A **cost** bound, not a chemical one, and it has to be far above anything a chemist can write or
 * it becomes a refusal: at 400 it rejected a 60-residue peptide (421 characters, RDKit-valid),
 * along with the macrocycles, PEG chains and glycans that routinely pass it — and it sat in front
 * of the paste confirmation, the inline draw toggle and the entity rail while the structure panel,
 * which never consulted this, accepted the same string. Parsing one long string in RDKit is far
 * cheaper than the surfaces the cap was disabling.
 */
const MAX_SMILES_CHARS = 4000;

/** The same bound for a reaction, which is several molecules plus an agents field. */
const MAX_REACTION_CHARS = 3 * MAX_SMILES_CHARS;

/**
 * Does this look like a SMILES string?
 *
 * Conservative, because chemistry prose is full of tokens that superficially resemble SMILES
 * (`pH`, `NMR`, `DMSO`, unit strings) and offering to render something that is not a molecule is
 * worse than not offering at all.
 *
 * **But not the way it used to be.** The rule this replaces — in `src/lib/citations.ts`, where it
 * was the only recogniser the app had — demanded a bracket, a digit or a bond character, on the
 * theory that plain words would otherwise pass. That rejected `CCO`. Ethanol is not an edge case,
 * and neither are `CC`, `CCN` or any other straight-chain molecule a chemist writes a dozen times
 * a day: none of them contains a structural character, so none of them was ever offered a
 * structure. The test that catches this is the first assertion in `tests/chem.test.tsx`.
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
 * Does this look like an MDL molblock?
 *
 * The header is four *fixed* lines — title, program, comment, counts — and the counts line ends in
 * the dialect tag. That is the whole test: positional, cheap, and it cannot fire on prose, because
 * line 4 of a pasted paragraph does not end in `V2000`.
 *
 * Here rather than in `rdkit.ts` for the reason everything in this file is here: it decides
 * whether asking the toolkit is worth it, so it must not need the toolkit to decide. What it is
 * for is the paste path — a molblock is multi-line by definition, so it is the one structure
 * payload the whitespace guard would throw away before RDKit ever saw it, while being what
 * ChemDraw, Ketcher and Marvin actually put on the clipboard.
 */
export function looksLikeMolblock(text: string): boolean {
  const counts = text.split(/\r?\n/)[3];
  return counts !== undefined && /V[23]000\s*$/.test(counts);
}

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
