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

interface TextNode extends Node {
  type: 'text';
  value: string;
}

interface LinkNode extends Node {
  type: 'link';
  url: string;
  children: Node[];
}

/** Identifier shapes the backend actually emits. Note stems come from the knowledge graph; QM
 *  job ids are minted by the Temporal workflow as `qm-<hash>`. */
const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'reaction', re: /\breaction-[A-Za-z0-9_-]{1,64}\b/g },
  { kind: 'note', re: /\bnote-[A-Za-z0-9_-]{1,64}\b/g },
  { kind: 'qm', re: /\bqm-[A-Za-z0-9]{4,64}\b/g },
];

const combined = new RegExp(PATTERNS.map((p) => p.re.source).join('|'), 'g');

const kindOf = (token: string): string => {
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    if (new RegExp(`^${re.source}$`).test(token)) return kind;
  }
  return 'note';
};

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

/**
 * The SMILES recogniser used to live here, and it demanded a bond/branch/ring character or a digit
 * so that plain words would not pass. That rejected `CCO` — ethanol, and every other
 * straight-chain molecule a chemist writes without punctuation. It now lives in
 * `src/chem/recognise.ts`, which asks the answerable question instead (could every letter be a
 * SMILES atom?) and is affordable being looser because RDKit is the arbiter behind it.
 *
 * This file keeps the citation half: which prose tokens are identifiers is a different question
 * from which are structures, and it is the one this module was named for.
 */
