/**
 * One proposed knowledge note, rendered as the thing it describes.
 *
 * A reviewer signing off on machine-written knowledge is signing off on *bytes*, so the raw file
 * is always one click away and the derived rendering never replaces it. What the rendering adds is
 * the part a wall of YAML hides: a `compound` note's `compound_smiles` is the only typed structure
 * field anywhere in this system's contracts, and a reviewer asked "is this the right molecule?"
 * should be able to answer it by looking rather than by reading SMILES.
 *
 * `>>` chooses the reaction renderer over the molecule one. That is the reaction-SMILES separator
 * and nothing else in a valid molecule SMILES contains it, so the test is exact rather than a
 * guess — and `Reaction` returns null on anything it cannot parse, which falls back to showing the
 * string itself.
 */

import { useState } from 'react';
import { Markdown } from '../components/Markdown.tsx';
import { Molecule, Reaction } from '../components/Molecule.tsx';
import { parseNote, field, list } from './frontmatter.ts';
import { Callout, Pill } from './ui.tsx';

/** Header keys rendered as their own thing above, so the metadata strip does not repeat them. */
const PROMOTED = new Set(['id', 'type', 'compound_smiles', 'tags', 'body']);

export function NoteView({
  content,
  path,
}: {
  content: string;
  /** The file's path in the tree, for a dependency. Omitted for the subject note, whose identity
   *  is its `id`. */
  path?: string;
}): React.JSX.Element {
  const note = parseNote(content);
  const [raw, setRaw] = useState(false);
  const smiles = field(note, 'compound_smiles');
  const tags = list(note, 'tags');

  return (
    <div className="rounded-md border border-border-subtle bg-surface-raised p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {path && <span className="font-mono text-xs break-all text-ink-muted">{path}</span>}
        {field(note, 'type') && <Pill tone="accent">{field(note, 'type')}</Pill>}
        {field(note, 'id') && <span className="font-mono text-sm">{field(note, 'id')}</span>}
        <button
          type="button"
          onClick={() => setRaw((v) => !v)}
          className="ml-auto rounded border border-border-subtle px-1.5 py-0.5 text-xs text-ink-muted hover:text-ink"
        >
          {raw ? 'rendered' : 'raw file'}
        </button>
      </div>

      {raw ? (
        <pre className="overflow-x-auto rounded bg-surface-sunken p-2 text-xs">{content}</pre>
      ) : (
        <>
          {!note.hasFrontmatter && (
            <p className="mb-2 text-xs text-ink-muted">
              No frontmatter — this file is not a note, so it is shown as written.
            </p>
          )}

          {smiles && (
            <div className="mb-3">
              {smiles.includes('>>') ? (
                <Reaction reactionSmiles={smiles} />
              ) : (
                <Molecule smiles={smiles} width={280} height={190} />
              )}
              <p className="mt-1 font-mono text-[11px] break-all text-ink-muted">{smiles}</p>
            </div>
          )}

          {tags.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded border border-border-subtle bg-surface-sunken px-1.5 py-0.5 text-xs text-ink-muted"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {note.hasFrontmatter && (
            <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
              {Object.entries(note.fields)
                .filter(([key]) => !PROMOTED.has(key))
                .map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="text-ink-muted">{key}</dt>
                    <dd className="break-all">
                      {Array.isArray(value) ? value.join(', ') || '—' : value}
                    </dd>
                  </div>
                ))}
            </dl>
          )}

          {note.unparsed.length > 0 && (
            <div className="mb-2">
              <Callout tone="warn" title="Not shown in this view">
                {note.unparsed.join(', ')} — structured entries this renderer does not model. Open
                the raw file before deciding; nothing has been dropped from it.
              </Callout>
            </div>
          )}

          {/* The note body is Markdown by contract. The shared renderer is reused rather than
              re-implemented: it chips note-id-shaped tokens — which is what a body `[[wikilink]]`
              contains — and it is the file that refuses raw HTML, a property this view needs for
              exactly the same reason the answer surface does. */}
          <Markdown>{note.body}</Markdown>
        </>
      )}
    </div>
  );
}
