/**
 * One knowledge-graph note, opened from the citation that referenced it.
 *
 * This is the surface `GET /notes/{id}` was added for. The service's own words:
 *
 * > a surface that renders `note-…` tokens as citation chips therefore had nothing to resolve
 * > them against, so a citation was a highlight rather than a link.
 *
 * What makes it worth a panel rather than a tooltip is the provenance. A note carries who wrote
 * it, which source it came from, a confidence, and a *validity window* — and the last one is the
 * one a reader cannot infer. The graph excludes an expired note from retrieval but still serves it
 * here, so a citation in an old answer can resolve to a note that no longer holds. Saying that out
 * loud is the difference between a link and a trap.
 *
 * Fetched when the panel opens, not when the chip renders. An answer can carry a dozen citations
 * and a chemist follows one.
 */

import { useCallback, useState } from 'react';
import { useAuth } from '../auth/AuthContext.tsx';
import { api, type NoteRef, type NoteView } from '../api/client.ts';
import { Markdown } from './LazyMarkdown.tsx';
import { Molecule } from './Molecule.tsx';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { EmptyState, Loading } from '@/components/chem/Feedback';

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; view: NoteView }
  | { status: 'failed'; message: string };

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
  const { auth } = useAuth();
  const [state, setState] = useState<State>({ status: 'idle' });

  const load = useCallback(
    (id: string) => {
      setState({ status: 'loading' });
      api
        .getNote(id, auth)
        .then((view) => setState({ status: 'ready', view }))
        .catch((err: unknown) =>
          setState({
            status: 'failed',
            message: err instanceof Error ? err.message : 'Could not read that note.',
          }),
        );
    },
    [auth],
  );

  // Keyed on `noteId` as well as `open` so following a neighbour refetches: the panel stays
  // mounted across that transition, and an effect on `open` alone would never fire again.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (open && loadedFor !== noteId) {
    setLoadedFor(noteId);
    load(noteId);
  }

  const note = state.status === 'ready' ? state.view.note : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" title={`Note ${noteId}`} className="w-[min(32rem,92vw)]">
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
          <div>
            <p className="font-mono text-xs break-all text-ink-muted">{noteId}</p>
            {note && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge tone="neutral">{note.type}</Badge>
                {/* A number without its scale is noise; the label says what 0.72 is a measure of. */}
                <Badge tone={note.confidence >= 0.7 ? 'ok' : 'warn'}>
                  <span className="font-mono tabular-nums">{note.confidence.toFixed(2)}</span>
                  <span className="font-normal opacity-80">confidence</span>
                </Badge>
                {isExpired(note) && <Badge tone="warn">superseded</Badge>}
              </div>
            )}
          </div>

          {state.status === 'loading' && <Loading>Reading the note…</Loading>}

          {state.status === 'failed' && (
            <EmptyState title="That note could not be read">
              <p>{state.message}</p>
              {/* The path this panel replaced, kept for when it cannot serve. Not every citation
                  is a note id — a `qm-…` reference names a job whose note may never have been
                  written — and the agent can still say what it knows about one. */}
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => {
                  onOpenChange(false);
                  onAsk(noteId);
                }}
              >
                Ask the agent about it instead
              </Button>
            </EmptyState>
          )}

          {state.status === 'ready' && (
            <>
              {isExpired(state.view.note) && (
                <p
                  role="alert"
                  className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn-ink"
                >
                  This note’s validity window has closed, so the graph no longer retrieves it. An
                  answer that cited it may have been written while it still held.
                </p>
              )}

              <Provenance note={state.view.note} />

              {state.view.note.tags.length > 0 && (
                <ul className="flex flex-wrap gap-1.5">
                  {state.view.note.tags.map((tag) => (
                    <li key={tag}>
                      <Badge tone="neutral">{tag}</Badge>
                    </li>
                  ))}
                </ul>
              )}

              {state.view.note.compound_smiles && (
                <Molecule smiles={state.view.note.compound_smiles} />
              )}

              <div className="border-t border-border-subtle pt-4 text-sm">
                <Markdown>{state.view.body}</Markdown>
              </div>

              {state.view.neighbors.length > 0 && (
                <div className="border-t border-border-subtle pt-4">
                  <h3 className="mb-2 text-2xs font-medium tracking-wide text-ink-subtle uppercase">
                    Linked notes
                  </h3>
                  <ul className="flex flex-col items-start gap-1">
                    {state.view.neighbors.map((neighbor) => (
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
        </div>
      </SheetContent>
    </Sheet>
  );
}
