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
 * component is one RDKit can read — **the agents field included**. That last word is not a
 * refinement: the recogniser checks the two ends only, so `CCO>ZZZZ>CC=O` was accepted, the strip
 * said "RDKit read this as CCO>ZZZZ>CC=O", and `Reaction` printed `ZZZZ` over the arrow as a
 * reagent. Either everything in the string is checked or the claim has to be withdrawn, and the
 * agents are chemistry a chemist reads off that arrow.
 *
 * ## A reaction is not canonicalised, and that is deliberate
 *
 * RDKit's minimal build ships no reaction object, and canonicalising each component separately
 * would produce a different string with no toolkit behind it — the same reasoning `entities.ts`
 * gives for keying a reaction on its raw text. So `canonical` is the input for a reaction, and the
 * `kind` is what tells a caller not to treat it as an identity.
 */

import { isMolecule, readCanonicalSmiles, type NotAChemicalVerdict } from './rdkit.ts';
import { looksLikeReactionSmiles, looksLikeSmiles } from './recognise.ts';

/**
 * What a structure-shaped string turned out to be.
 *
 * Three kinds rather than two, and the third is not a kind of chemistry. `too-complex` is a
 * molecule RDKit read and then could not name, because canonical ranking recursed past this
 * thread's stack (`rdkit.engine.ts`'s `Refused`). It is here rather than folded into the `null`
 * beside it because `null` means "not a structure" and a caller renders that as silence, while
 * this one has to be said out loud: the string on screen *is* a structure and the sentence a
 * surface would otherwise reach for is "RDKit could not read this as a molecule".
 *
 * It carries no `canonical`, which is the point — there is no name, so nothing downstream can key
 * it, and the compiler is what enforces that rather than a comment.
 */
export type ReadStructure =
  | {
      kind: 'molecule' | 'reaction';
      /** What was read. For a molecule, RDKit's canonical form; for a reaction, the input
       *  unchanged. */
      canonical: string;
      /** The string as it was given, so a caller can show a chemist their own spelling beside
       *  ours. */
      raw: string;
    }
  | {
      /** Derived from `Refused` rather than restated, so a refusal added there cannot be folded
       *  into the `null` beside it without the compiler saying so here and at both surfaces that
       *  read this — see `NotAChemicalVerdict`. */
      kind: NotAChemicalVerdict;
      raw: string;
    };

/**
 * What `text` is, or `null` if it is not a structure at all.
 *
 * The syntactic check runs first and is what keeps the WASM out of the hot path: an answer full of
 * ordinary prose asks RDKit nothing. A token that passes it is then handed to RDKit, whose answer
 * is final — the recogniser proposes, RDKit disposes.
 *
 * **A reaction cannot come back `too-complex`**, and that is measured rather than assumed: its
 * components go through `isMolecule`, which never asks for a canonical name and therefore never
 * reaches the recursion that overflows (see `isMolecule` in `rdkit.engine.ts`). So the third kind
 * is only ever a molecule, which is also the only kind that has a name to lose.
 */
export async function readStructure(text: string): Promise<ReadStructure | null> {
  const raw = text.trim();
  if (!raw) return null;

  if (looksLikeReactionSmiles(raw)) {
    const [reactants = '', agents = '', products = ''] = raw.split('>');
    const components = [reactants, agents, products]
      .flatMap((side) => side.split('.'))
      .filter(Boolean);
    // Every component, not just one: a reaction with an unreadable product would draw as a
    // half-reaction with a silently missing side, which is worse than not drawing it. The agents
    // are in this list because they are rendered over the arrow and claimed as read.
    const readable = await Promise.all(components.map(isMolecule));
    return readable.every(Boolean) ? { kind: 'reaction', canonical: raw, raw } : null;
  }

  if (!looksLikeSmiles(raw)) return null;
  const read = await readCanonicalSmiles(raw);
  switch (read.status) {
    case 'named':
      return { kind: 'molecule', canonical: read.canonical, raw };
    case 'too-complex':
      return { kind: 'too-complex', raw };
    case 'unreadable':
      return null;
    default: {
      // **Exhaustiveness, and it is the assertion rather than the comment.** `null` here means
      // "not a structure", which every caller renders as silence or as "not a molecule" — so a
      // refusal added to `Refused` and not answered above would make a false chemical claim about
      // a string this module declined for a reason of its own. The binding is what stops that
      // compiling; before it, a third member went through `npx tsc -b` at exit 0.
      const unanswered: never = read;
      return unanswered;
    }
  }
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
