/**
 * "Is this string a structure, and what exactly?" — asked in one place, combining the syntactic
 * guess (`recognise.ts`) with RDKit (`rdkit.ts`) for the composer's paste check, the inline toggle
 * and the structure panel.
 *
 * A molecule is canonicalised; a reaction is accepted only when every component (agents included)
 * is readable, and is not canonicalised (RDKit's minimal build has no reaction object) — `kind`
 * tells callers not to use it as an identity.
 */

import { isMolecule, readCanonicalSmiles, type NotAChemicalVerdict } from './rdkit.ts';
import { looksLikeReactionSmiles, looksLikeSmiles } from './recognise.ts';

/**
 * What a structure-shaped string turned out to be. `too-complex` is a molecule RDKit read but could
 * not name on this thread (`Refused` in `rdkit.engine.ts`); it carries no `canonical`, so nothing
 * can key it, and callers must say so rather than "not a molecule".
 */
export type ReadStructure =
  | {
      kind: 'molecule' | 'reaction';
      /**
       * What was read: RDKit's canonical form for a molecule, the input unchanged for a reaction.
       */
      canonical: string;
      /** The string as given, so the chemist's spelling can be shown beside ours. */
      raw: string;
    }
  | {
      /** Derived from `Refused` (see `NotAChemicalVerdict`), so a new refusal must be handled. */
      kind: NotAChemicalVerdict;
      raw: string;
    };

/**
 * What `text` is, or `null` if not a structure. The syntactic check runs first so prose never
 * reaches RDKit. A reaction cannot come back `too-complex`: its components go through `isMolecule`,
 * which never canonicalises.
 */
export async function readStructure(text: string): Promise<ReadStructure | null> {
  const raw = text.trim();
  if (!raw) return null;

  if (looksLikeReactionSmiles(raw)) {
    const [reactants = '', agents = '', products = ''] = raw.split('>');
    const components = [reactants, agents, products]
      .flatMap((side) => side.split('.'))
      .filter(Boolean);
    // Every component, agents included: they are drawn over the arrow and claimed as read.
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
      // Exhaustiveness: an unhandled refusal must not become a silent "not a structure".
      const unanswered: never = read;
      return unanswered;
    }
  }
}

/**
 * Could `text` be a structure on syntax alone? For callers that must decide synchronously whether
 * asking RDKit is worth it (the markdown renderer).
 */
export const mightBeStructure = (text: string): boolean =>
  looksLikeSmiles(text) || looksLikeReactionSmiles(text);
