/**
 * A citation rendered inline in an answer. Clicking resolves it via `GET /notes/{id}`; if that
 * fails (a `qm-…` job may have no note), it falls back to asking the agent.
 *
 * The chip owns its panel: it sits deep in markdown output with no props, and the panel needs only
 * auth from context.
 */

import { useState } from 'react';
import { cn } from '../lib/cn.ts';
import { NoteSheet } from './NoteSheet.tsx';
import { prefill } from '../state/composerEvents.ts';

/**
 * One tone per kind `remarkCitations` emits. Job and note ids look different on purpose: a note
 * resolves in the graph, a job may have no note.
 */
const PALETTE: Record<string, string> = {
  note: 'border-border-subtle bg-surface-sunken text-ink-muted',
  job: 'border-ok/40 bg-ok-soft text-ok-ink',
};

/** The pre-route behaviour: hand the composer a question about the reference. */
function ask(id: string): void {
  prefill(`Expand ${id} — what are the conditions, outcomes, and caveats?`);
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
