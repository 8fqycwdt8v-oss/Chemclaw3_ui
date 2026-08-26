/**
 * "Is this string a structure, and what exactly?" — asked in one place.
 *
 * `recognise.ts` is the cheap syntactic guess and imports no RDKit; `rdkit.ts` is the toolkit and
 * knows nothing about which prose tokens are worth asking about. This module is the one function
 * that puts them together, and it exists because three surfaces were about to ask the same question
 * three slightly different ways: the composer's paste confirmation, the inline toggle in an answer,
 * and the structure panel.
 *
 * Three slightly different ways is how the recogniser and the arbiter end up disagreeing about a
 * string nobody has typed yet, which is the failure `Molecule.tsx` gave up smiles-drawer to avoid.
 *
 * ## Reactions were falling through, everywhere
 *
 * `looksLikeSmiles` rejects anything containing `>` — deliberately, so it cannot disagree with
 * `looksLikeReactionSmiles` — and `isMolecule` refuses a reaction because a molecule toolkit parses
 * molecules. So every surface that asked "can I draw this" via `isMolecule` alone said no to every
 * reaction, while `Molecule` has been able to draw them all along. `readStructure` asks the right
 * question of each kind: a molecule is canonicalised, and a reaction is accepted when *every*
 * component on both sides is one RDKit can read.
 *
 * ## A reaction is not canonicalised, and that is deliberate
 *
 * RDKit's minimal build ships no reaction object, and canonicalising each component separately
 * would produce a different string with no toolkit behind it — the same reasoning `entities.ts`
 * gives for keying a reaction on its raw text. So `canonical` is the input for a reaction, and the
 * `kind` is what tells a caller not to treat it as an identity.
 */

import { canonicalSmiles, isMolecule } from './rdkit.ts';
import { looksLikeReactionSmiles, looksLikeSmiles } from './recognise.ts';

export interface ReadStructure {
  kind: 'molecule' | 'reaction';
  /** What was read. For a molecule, RDKit's canonical form; for a reaction, the input unchanged. */
  canonical: string;
  /** The string as it was given, so a caller can show a chemist their own spelling beside ours. */
  raw: string;
}

/**
 * What `text` is, or `null` if it is not a structure at all.
 *
 * The syntactic check runs first and is what keeps the WASM out of the hot path: an answer full of
 * ordinary prose asks RDKit nothing. A token that passes it is then handed to RDKit, whose answer
 * is final — the recogniser proposes, RDKit disposes.
 */
export async function readStructure(text: string): Promise<ReadStructure | null> {
  const raw = text.trim();
  if (!raw) return null;

  if (looksLikeReactionSmiles(raw)) {
    const [reactants = '', , products = ''] = raw.split('>');
    const components = [reactants, products].flatMap((side) => side.split('.')).filter(Boolean);
    // Every component, not just one: a reaction with an unreadable product would draw as a
    // half-reaction with a silently missing side, which is worse than not drawing it.
    const readable = await Promise.all(components.map(isMolecule));
    return readable.every(Boolean) ? { kind: 'reaction', canonical: raw, raw } : null;
  }

  if (!looksLikeSmiles(raw)) return null;
  const canonical = await canonicalSmiles(raw);
  return canonical ? { kind: 'molecule', canonical, raw } : null;
}

/**
 * Could `text` be a structure, on syntax alone?
 *
 * The synchronous half, for a caller that has to decide whether asking RDKit is worth it before it
 * has an answer — the markdown renderer, which sees every inline code span in every answer and must
 * not fetch a 6.9 MB binary to find out that `pH` is not a molecule.
 */
export const mightBeStructure = (text: string): boolean =>
  looksLikeSmiles(text) || looksLikeReactionSmiles(text);
