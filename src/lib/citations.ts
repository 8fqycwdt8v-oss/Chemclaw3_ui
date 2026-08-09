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
import type { TraceEntry } from '../state/types.ts';

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
 * The note ids this turn's tools actually returned, deduplicated across every call.
 *
 * The exact counterpart of `returnedFigures` in `src/chem/provenance.ts`, one field over: where
 * that one answers "which values did the model see", this answers "which notes did the model see".
 * Both are untruncated, both are per message rather than per call — the answer is written after all
 * of them and never says which call an id came from — and both treat empty as load-bearing. Empty
 * means this turn has no authoritative list, which is not the same as "it cited nothing", and it is
 * what switches `remarkCitations` back to guessing at the shape of tokens in prose.
 */
export function returnedNoteIds(trace: readonly TraceEntry[]): string[] {
  const seen = new Set<string>();
  for (const entry of trace) {
    for (const id of entry.toolCall?.noteIds ?? []) {
      const trimmed = id.trim();
      if (trimmed) seen.add(trimmed);
    }
  }
  return [...seen];
}

const escapeForRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Boundaries for an exact id, written out rather than left to `\b`.
 *
 * `\b` is a boundary between a word and a non-word character, and a note id continues past several
 * of those: `rxn-4821` sits inside `rxn-4821.a`, and `\b` on the `.` would chip a *prefix* of the
 * token in the text as though the whole id had matched. So the alphabet an id may continue with
 * (`looksLikeNoteId`: `[A-Za-z0-9_.-]`) is what must not follow.
 *
 * Except a trailing `.` — which is how a chemist ends a sentence, and demanding its absence outright
 * meant no id at the end of one was ever chipped. A `.` only continues an id when a character of
 * the id follows it, which is exactly what the second lookaround says.
 */
const NOT_ID_BEFORE = '(?<![A-Za-z0-9_-])(?<![A-Za-z0-9]\\.)';
const NOT_ID_AFTER = '(?![A-Za-z0-9_-])(?!\\.[A-Za-z0-9])';

/**
 * What to linkify, given what this turn knows.
 *
 * **With `noteIds`** — `tool_result.note_ids`, the untruncated list of ids the service put in front
 * of the model this turn — the notes are matched exactly and the prefix heuristic is not consulted
 * at all. It is the answer to the question the heuristic was approximating, so consulting both
 * would only re-admit the guess's false positives.
 *
 * **Without them** — an older backend, or a turn whose tools returned no ids — it falls back to the
 * shapes `src/chem/recognise.ts` reads off the corpus. That list is a real improvement on the one
 * before it (`reaction-`, `note-` and `qm-`, of which the first two matched *nothing* the backend
 * has ever written), but it is still a guess over prose and it stays the fallback rather than the
 * rule.
 *
 * Job ids come from the pattern in both branches: `note_ids` says nothing about them, so they are
 * not a thing the authoritative list can supersede.
 *
 * The consequence worth stating plainly: with an authoritative list, an id the model wrote that the
 * turn's tools did *not* return gets no chip. It is left as ordinary text and is not marked as
 * anything — a chip that cannot be followed would over-promise, and a warning on it would be the
 * fabrication verdict `src/chem/provenance.ts` documents this codebase refusing to hand out.
 */
function citationPattern(noteIds: readonly string[]): RegExp {
  if (noteIds.length === 0) {
    return new RegExp([NOTE_ID_PATTERN.source, JOB_ID_PATTERN.source].join('|'), 'g');
  }
  // Longest first. The boundaries above already refuse `compound-4` inside
  // `compound-4-bromoanisole`, so this is not what makes overlapping ids safe — it makes the
  // alternation prefer the whole id outright rather than reaching it by backtracking, which keeps
  // the match the same whichever order the service happened to list them in.
  const exact = [...noteIds]
    .sort((a, b) => b.length - a.length)
    .map(escapeForRegExp)
    .join('|');
  return new RegExp(
    `${NOT_ID_BEFORE}(?:${exact})${NOT_ID_AFTER}|${JOB_ID_PATTERN.source}`,
    'g',
  );
}

/** A token the service named as a note is a note, whatever its prefix happens to look like —
 *  `report-` and `bo-` are minted as both note ids and job ids. */
const kindOf = (token: string, authoritative: ReadonlySet<string>): string =>
  authoritative.has(token) || !isJobId(token) ? 'note' : 'job';

/**
 * Remark plugin. Splits text nodes on citation tokens and emits links with a `#cite/<kind>/<id>`
 * href, which `<Markdown>` renders as a citation chip.
 *
 * Takes the turn's authoritative note ids as its plugin options, the same way `remarkGrounding`
 * takes its returned figures. `<Markdown>` threads both down from the message's trace; a caller
 * with no turn behind the text — `NoteView`, rendering a stored note body — passes neither and
 * gets the heuristic, which is the right answer there rather than a degraded one.
 */
export function remarkCitations(noteIds: readonly string[] = []) {
  const pattern = citationPattern(noteIds);
  const authoritative = new Set(noteIds);

  return (tree: Node): void => {
    visit(tree, 'text', (node: TextNode, index: number | undefined, parent: Parent | undefined) => {
      if (!parent || index === undefined) return;
      // Never rewrite inside code or an existing link.
      if (parent.type === 'link' || parent.type === 'inlineCode' || parent.type === 'code') {
        return SKIP;
      }

      const value = node.value;
      // `matchAll` iterates a clone, so `pattern` carries no `lastIndex` between nodes.
      const matches = [...value.matchAll(pattern)];
      if (matches.length === 0) return;

      const children: Node[] = [];
      let cursor = 0;
      for (const match of matches) {
        const token = match[0];
        const start = match.index ?? 0;
        if (start > cursor) {
          children.push({ type: 'text', value: value.slice(cursor, start) } as TextNode);
        }
        children.push({
          type: 'link',
          url: `#cite/${kindOf(token, authoritative)}/${token}`,
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
