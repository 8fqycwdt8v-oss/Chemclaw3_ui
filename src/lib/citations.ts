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
 * A heuristic "does this look like a SMILES string" test, used to offer a render affordance on
 * inline code spans.
 *
 * Deliberately conservative. Chemistry prose is full of tokens that superficially resemble SMILES
 * (`pH`, `NMR`, `1H`, unit strings), and auto-rendering a structure for something that is not a
 * molecule is worse than not offering it at all — so this demands a bond/branch/ring character
 * and rejects anything with whitespace or characters SMILES never uses.
 */
export function looksLikeSmiles(text: string): boolean {
  const s = text.trim();
  // The upper bound is a main-thread guard as much as a heuristic: `smiles-drawer`'s parse is
  // synchronous, so an adversarially long string from model output would block rendering. 200 is
  // far above any structure that reads sensibly inline.
  if (s.length < 4 || s.length > 200) return false;
  if (/\s/.test(s)) return false;
  if (!/^[A-Za-z0-9@+\-[\]()=#$%/\\.*]+$/.test(s)) return false;

  // Reject the chemistry-prose tokens this claimed to reject and did not.
  //
  // The docstring above has always said it rejects things like `pH` — but trace `pH=7.4` through
  // the old rules: length 6, no whitespace, every character in the allowed set, `=` satisfies the
  // structural requirement and `p` satisfies the organic-subset one. It passed, and so did
  // `1H-NMR` and `C2H5OH`, each producing a ⌬ toggle on prose that errors when clicked.
  //
  // What actually distinguishes them is that they are measurements and labels, not structures:
  // a `=` used as assignment rather than a double bond, a decimal number, an NMR/IR label.
  if (/^[a-zA-Z]{1,3}\s*=/.test(s)) return false; // pH=7.4, T=298, dH=-45
  if (/\d\.\d/.test(s)) return false; // any decimal figure
  if (/^\d+[HCNPF]-/i.test(s)) return false; // 1H-NMR, 13C-NMR
  if (/(NMR|IR|MS|HPLC|GC|UV|TLC|ppm|equiv)/i.test(s)) return false;

  // Require at least one structural character; plain words would otherwise pass.
  if (!/[()[\]=#]|[0-9]/.test(s)) return false;
  // Must contain an element that can start an organic-subset atom.
  if (!/[CNOPSFBIcnops]/.test(s)) return false;
  return true;
}
