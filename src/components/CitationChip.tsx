/**
 * A citation reference rendered inline in an answer.
 *
 * It used to be a prompt button. There was no knowledge-graph read route on the HTTP surface, so
 * clicking a chip dropped "Expand note-123 — what are the conditions…" into the composer and made
 * the chemist spend another turn to read what the last one had already cited.
 *
 * `GET /notes/{id}` exists now, and a citation resolves. The old behaviour survives as the failure
 * path rather than as the default, and it earns its place: not every chip is a note id. A `qm-…`
 * reference names a job, whose `job-result` note may never have been written, and the agent can
 * still say something useful about one. So the chip tries the graph and falls back to asking.
 *
 * The chip owns its own panel rather than dispatching to a host component. These are rendered deep
 * inside markdown output with no props threaded to them — the same constraint that produced the
 * `chemclaw:prefill` window event — but the panel needs only auth, which is context, and one
 * chemist follows one citation at a time.
 */

import { useState } from 'react';
import { cn } from '../lib/cn.ts';
import { NoteSheet } from './NoteSheet.tsx';

/**
 * One tone per kind `remarkCitations` can emit, and no more.
 *
 * It carried `reaction` and `qm` rows that no producer could reach — the plugin never emitted those
 * kinds once its prefixes were read off the corpus — while `job`, which it does emit, had no row and
 * fell through to the note tone. So a job id and a note id looked identical, which is the one
 * distinction a reader needs: a note resolves in the graph, a job may have no note at all.
 */
const PALETTE: Record<string, string> = {
  note: 'border-border-subtle bg-surface-sunken text-ink-muted',
  job: 'border-ok/40 bg-ok-soft text-ok-ink',
};

/** The pre-route behaviour: hand the composer a question about the reference. */
function ask(id: string): void {
  window.dispatchEvent(
    new CustomEvent('chemclaw:prefill', {
      detail: `Expand ${id} — what are the conditions, outcomes, and caveats?`,
    }),
  );
}

export function CitationChip({ kind, id }: { kind: string; id: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  // Which note the panel is showing, which is not always the one the chip names: following a
  // linked note re-targets the same panel rather than stacking a second one on top of it.
  const [showing, setShowing] = useState(id);

  return (
    <>
      <button
        type="button"
        title={`Open ${id}`}
        onClick={() => {
          setShowing(id);
          setOpen(true);
        }}
        className={cn(
          'mx-0.5 inline-flex items-center rounded border px-1.5 py-px align-baseline',
          'font-mono text-[0.8em] leading-normal transition-colors hover:brightness-95',
          PALETTE[kind] ?? PALETTE.note,
        )}
      >
        {id}
      </button>
      {/* Mounted only once opened: an answer can carry a dozen citations, and a Radix root per
          chip on every rendered message is a cost with nothing behind it until one is clicked. */}
      {open && (
        <NoteSheet
          noteId={showing}
          open={open}
          onOpenChange={setOpen}
          onFollow={setShowing}
          onAsk={ask}
        />
      )}
    </>
  );
}
