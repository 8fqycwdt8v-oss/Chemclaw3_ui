/**
 * Linkify the agent's citations.
 *
 * The agent's instructions require it to "cite the note id behind every claim", but those ids
 * arrive as unstructured text inside the answer — there is no citation array on the wire. So we
 * find them in the markdown AST.
 *
 * A remark plugin rather than a regex over rendered HTML: a post-hoc regex would happily rewrite
 * `reaction-abc` inside a code fence, inside an inline `code` span, or inside an existing link's
 * text, all of which are wrong and all of which occur in real answers about reaction SMILES.
 */

import { visit, SKIP } from 'unist-util-visit';
import type { Node, Parent } from 'unist';
import { JOB_ID_PATTERN, NOTE_ID_PATTERN, isJobId } from '../chem/recognise.ts';

interface TextNode extends Node {
  type: 'text';
  value: string;
}

interface LinkNode extends Node {
  type: 'link';
  url: string;
  children: Node[];
}

/**
 * Identifier shapes the backend actually emits.
 *
 * The previous list here was `reaction-`, `note-` and `qm-`, and the first two matched **nothing**:
 * a note of type `reaction` has an id beginning `rxn-`, and no note this system has ever written
 * begins `note-`. So the chip that exists to make a citation checkable was firing on almost no real
 * citation. The prefixes now come from `src/chem/recognise.ts`, which reads them off the corpus.
 *
 * Still a heuristic over prose: `tool_result.note_ids` is the exact answer to which notes a turn
 * saw, and a caller holding it should prefer it.
 */
const combined = new RegExp(
  [NOTE_ID_PATTERN.source, JOB_ID_PATTERN.source].join('|'),
  'g',
);

const kindOf = (token: string): string => (isJobId(token) ? 'job' : 'note');

/**
 * Remark plugin. Splits text nodes on citation-shaped tokens and emits links with a
 * `#cite/<kind>/<id>` href, which `<Markdown>` renders as a citation chip.
 */
export function remarkCitations() {
  return (tree: Node): void => {
    visit(tree, 'text', (node: TextNode, index: number | undefined, parent: Parent | undefined) => {
      if (!parent || index === undefined) return;
      // Never rewrite inside code or an existing link.
      if (parent.type === 'link' || parent.type === 'inlineCode' || parent.type === 'code') {
        return SKIP;
      }

      combined.lastIndex = 0;
      const value = node.value;
      if (!combined.test(value)) return;
      combined.lastIndex = 0;

      const children: Node[] = [];
      let cursor = 0;
      for (const match of value.matchAll(combined)) {
        const token = match[0];
        const start = match.index ?? 0;
        if (start > cursor) {
          children.push({ type: 'text', value: value.slice(cursor, start) } as TextNode);
        }
        children.push({
          type: 'link',
          url: `#cite/${kindOf(token)}/${token}`,
          children: [{ type: 'text', value: token } as TextNode],
        } as LinkNode);
        cursor = start + token.length;
      }
      if (cursor < value.length) {
        children.push({ type: 'text', value: value.slice(cursor) } as TextNode);
      }

      parent.children.splice(index, 1, ...(children as Parent['children']));
      // Skip past what we just inserted so the visitor does not re-scan our own link text.
      return [SKIP, index + children.length];
    });
  };
}

/** Re-exported so the markdown renderer keeps one import for "what does this text look like".
 *  The recogniser itself lives with the rest of the chemistry in `src/chem/recognise.ts`. */
export { looksLikeSmiles } from '../chem/recognise.ts';
