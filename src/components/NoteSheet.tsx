/**
 * One knowledge-graph note, opened from a citation (`GET /notes/{id}`).
 *
 * A panel rather than a tooltip because of provenance: author, source, confidence and validity
 * window. An expired note is still served here, so a citation can resolve to a note that no longer
 * holds; this says so. Fetched when the panel opens, not when the chip renders.
 */

import { useAuth } from '../auth/AuthContext.tsx';
import { useApiQuery } from '../api/queryClient.ts';
import { noteQuery } from '../api/queries.ts';
import type { NoteRef } from '../api/client.ts';
import { Markdown } from './LazyMarkdown.tsx';
import { Molecule } from './Molecule.tsx';
import { UseStructure } from '@/components/chem/UseStructure';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { EmptyState, Loading } from '@/components/chem/Feedback';

/** A date the service may or may not have set, rendered as a date or as the open end of a range. */
function boundary(value: string | null, openLabel: string): string {
  if (!value) return openLabel;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toLocaleDateString();
}

/** True when the note's validity window has closed. The graph would no longer retrieve it. */
function isExpired(note: NoteRef): boolean {
  if (!note.valid_to) return false;
  const end = new Date(note.valid_to).getTime();
  return !Number.isNaN(end) && end < Date.now();
}

function Provenance({ note }: { note: NoteRef }): React.JSX.Element {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {[
        ['Type', note.type],
        ['Source', note.source || 'not recorded'],
        ['Author', note.created_by || 'not recorded'],
        [
          'Valid',
          `${boundary(note.valid_from, 'from the start')} → ${boundary(note.valid_to, 'no end set')}`,
        ],
      ].map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-ink-subtle">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function NoteSheet({
  noteId,
  open,
  onOpenChange,
  /** Following a neighbour re-targets this panel instead of stacking another one on top. */
  onFollow,
  /** The pre-route behaviour, kept as the failure path: ask the agent to expand it instead. */
  onAsk,
}: {
  noteId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFollow: (noteId: string) => void;
  onAsk: (noteId: string) => void;
}): React.JSX.Element {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" title={`Note ${noteId}`} className="w-[min(32rem,92vw)]">
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
          <NoteBody
            noteId={noteId}
            enabled={open}
            onFollow={onFollow}
            onAsk={(id) => {
              onOpenChange(false);
              onAsk(id);
            }}
            onUsed={() => onOpenChange(false)}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The note itself without the sheet. Shared by the citation panel and `link` artefacts targeting a
 * note, so the two cannot disagree.
 */
export function NoteBody({
  noteId,
  enabled,
  onFollow,
  onAsk,
  onUsed,
}: {
  noteId: string;
  /** Fetch only while somebody can see it — the sheet stays mounted behind a closed panel. */
  enabled: boolean;
  onFollow: (noteId: string) => void;
  /** The note could not be read: ask the agent about it instead. */
  onAsk: (noteId: string) => void;
  /** A structure in the note was put into the composer. */
  onUsed: () => void;
}): React.JSX.Element {
  const { auth } = useAuth();
  /**
   * The note, keyed on `noteId`, so a stale read for a previous neighbour can never render under
   * the current heading. `enabled` follows the sheet's `open`, since the panel stays mounted behind
   * a closed sheet.
   */
  const { data: view, error, isPending } = useApiQuery({ ...noteQuery(noteId, auth), enabled });

  const note = view?.note ?? null;

  return (
    <>
      <div>
        <p className="font-mono text-xs break-all text-ink-muted">{noteId}</p>
        {note && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{note.type}</Badge>
            {/* Confidence is labelled with its scale; `null` is common (most producers score nothing), so the absence is stated. */}
            {note.confidence === null ? (
              <Badge tone="neutral">no confidence recorded</Badge>
            ) : (
              <Badge tone={note.confidence >= 0.7 ? 'ok' : 'warn'}>
                <span className="font-mono tabular-nums">{note.confidence.toFixed(2)}</span>
                <span className="font-normal opacity-80">confidence</span>
              </Badge>
            )}
            {isExpired(note) && <Badge tone="warn">superseded</Badge>}
          </div>
        )}
      </div>

      {isPending && !error && <Loading>Reading the note…</Loading>}

      {error && (
        <EmptyState title="That note could not be read">
          <p>{error.message}</p>
          {/* Fallback when the note cannot be served: not every citation is a note (a `qm-…` job may have none), and the agent can still answer. */}
          <Button variant="outline" size="sm" className="mt-3" onClick={() => onAsk(noteId)}>
            Ask the agent about it instead
          </Button>
        </EmptyState>
      )}

      {view && (
        <>
          {isExpired(view.note) && (
            <p
              role="alert"
              className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn-ink"
            >
              This note’s validity window has closed, so the graph no longer retrieves it. An answer
              that cited it may have been written while it still held.
            </p>
          )}

          <Provenance note={view.note} />

          {view.note.tags.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {view.note.tags.map((tag) => (
                <li key={tag}>
                  <Badge tone="neutral">{tag}</Badge>
                </li>
              ))}
            </ul>
          )}

          {view.note.compound_smiles && (
            <div>
              <Molecule smiles={view.note.compound_smiles} />
              {/* Put the note's compound in the composer; closing the sheet is part of the action. */}
              <div className="mt-1 flex justify-end">
                <UseStructure smiles={view.note.compound_smiles} label onUsed={onUsed} />
              </div>
            </div>
          )}

          <div className="border-t border-border-subtle pt-4 text-sm">
            <Markdown>{view.body}</Markdown>
          </div>

          {view.neighbors.length > 0 && (
            <div className="border-t border-border-subtle pt-4">
              <h3 className="mb-2 text-2xs font-medium tracking-wide text-ink-subtle uppercase">
                Linked notes
              </h3>
              <ul className="flex flex-col items-start gap-1">
                {view.neighbors.map((neighbor) => (
                  <li key={neighbor.id}>
                    <Button
                      variant="link"
                      size="xs"
                      className="h-auto p-0 font-mono text-2xs"
                      onClick={() => onFollow(neighbor.id)}
                    >
                      {neighbor.id}
                      <span className="font-sans text-ink-subtle">{neighbor.type}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </>
  );
}
