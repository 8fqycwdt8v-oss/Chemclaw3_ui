/**
 * Linkify the agent's citations. Ids arrive as plain text in the answer, so they are found in the
 * markdown AST; a remark plugin, unlike a regex over HTML, leaves code fences, inline code and link
 * text alone.
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

/**
 * Note-id prefixes the backend writes into `knowledge/`. `qm-` and the job prefixes cover durable
 * job ids (`<connector>-<hash>`), whose `job-result` note may not exist, which is why
 * `CitationChip` can fall back to asking the agent.
 *
 * ELN/ORD reaction records (`reaction-<source>.<id>` or `reaction-<id>`, from core's
 * `note_id_for_reaction`) have their own narrower pattern below, requiring a digit or a `<source>.`
 * qualifier so prose like "reaction-energy" stays text.
 */
const NOTE_PREFIXES = [
  'compound',
  'rxn',
  'playbook',
  'campaign',
  'opt',
  'interaction',
  'report',
  'failure',
  'proposal',
  'bo-candidate',
  'job-result',
] as const;

const PATTERNS: { kind: string; re: RegExp }[] = [
  {
    kind: 'note',
    re: new RegExp(`\\b(?:${NOTE_PREFIXES.join('|')})-[A-Za-z0-9][A-Za-z0-9_.-]*\\b`, 'g'),
  },
  // An experimental record: `reaction-<source>.<id>` or `reaction-<id>`, told apart from prose
  // ("reaction-energy", "reaction-level") by a digit or a qualifier dot followed by more id.
  {
    kind: 'note',
    re: /\breaction-(?=[A-Za-z0-9_-]*(?:[0-9]|\.[A-Za-z0-9]))[A-Za-z0-9][A-Za-z0-9_.-]*\b/g,
  },
  { kind: 'job', re: /\b(?:qm|calc|bo|report)-[A-Za-z0-9]{4,64}\b/g },
];

const combined = new RegExp(PATTERNS.map((p) => p.re.source).join('|'), 'g');

// `report-` is both a note and a job prefix. Classify job-shaped ids first: `PATTERNS` order only
// governs tokenising, this order breaks the tie.
const CLASSIFICATION_ORDER = ['job', 'note'] as const;

const kindOf = (token: string): string => {
  for (const kind of CLASSIFICATION_ORDER) {
    const pattern = PATTERNS.find((p) => p.kind === kind);
    if (!pattern) continue;
    pattern.re.lastIndex = 0;
    if (new RegExp(`^${pattern.re.source}$`).test(token)) return kind;
  }
  return 'note';
};

/**
 * The href scheme `<Markdown>` renders as a citation chip (cf. `#figure/` in `provenance.ts`);
 * exported so the renderer can strip it rather than repeat the literal.
 */
export const CITE_HREF = '#cite/';

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
          url: `${CITE_HREF}${kindOf(token)}/${token}`,
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
 * SMILES recognition lives in `src/chem/recognise.ts`; this module handles only citation
 * identifiers.
 */
