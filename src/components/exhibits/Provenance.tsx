/**
 * The provenance marker on a bound value, and the strip for bindings whose source is gone.
 *
 * ## A popover, not a tooltip
 *
 * A tooltip is a description and holds no controls (`ui/tooltip.tsx`), and this one has to hold
 * **Detach**. So the marker is a button that opens a small non-modal popover: the tool, the JSON
 * Pointer into its result, the result's short handle, and — on the head — the one action that turns
 * the value into ordinary, editable content. The button's accessible name carries the whole fact
 * ("From predict_yield, /0/yield"), so a screen reader hears where the value came from without
 * opening anything, and the visible cell keeps its number.
 *
 * ## Detach captures the revision it was opened on
 *
 * `onDetach` is read when the popover *opens* and kept, for `useRevise`'s reason: the head can
 * refetch while the popover is open, and a detach that read the newer view would post that view's
 * value as the child of a revision the chemist never looked at. Captured at open, a moved head is
 * a 409 and the same rebase prompt every other edit gets.
 */

import { useState } from 'react';
import { Popover } from 'radix-ui';
import { Link2, TriangleAlert, Unlink } from 'lucide-react';
import type { Binding } from '../../../shared/exhibits.ts';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { isStructureCitation, shortRef, type Provenance } from './bindings.ts';

/** The sentence a gone source is announced with — the contract's wording. */
export const SOURCE_GONE = 'source no longer available';

/** What the marker's button is called, and what a screen reader hears beside the value. */
export function markerLabel(provenance: Provenance): string {
  const from = `From ${provenance.tool || 'a tool result'}, ${provenance.pointer || '/'}`;
  return provenance.ok === false ? `${from} — ${SOURCE_GONE}` : from;
}

export function ProvenanceMarker({
  provenance,
  onDetach,
  detachDisabled,
  className,
}: {
  provenance: Provenance;
  /** Absent when the value cannot be detached here (not the head, or nothing to keep). */
  onDetach?: () => void;
  detachDisabled?: boolean;
  className?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  // See the module header: the action is the one the popover was opened over. Held in state as a
  // one-element box, because a function handed to a state setter is called rather than stored.
  const [opened, setOpened] = useState<{ act?: () => void }>({});
  const gone = provenance.ok === false;
  const Icon = gone ? TriangleAlert : Link2;

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) setOpened({ act: onDetach });
        setOpen(next);
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={markerLabel(provenance)}
          data-bound={gone ? 'gone' : 'ok'}
          className={cn(
            'inline-flex size-4 shrink-0 items-center justify-center rounded-sm align-middle focus-ring',
            gone ? 'text-warn-ink' : 'text-brand hover:bg-surface-sunken',
            className,
          )}
        >
          <Icon aria-hidden className="size-3" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          aria-label="Where this value came from"
          side="top"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 flex max-w-72 flex-col gap-2 rounded-md border border-border-subtle bg-surface-overlay p-3 text-xs text-ink shadow-md focus-ring"
        >
          <p className="font-medium">
            {gone
              ? 'Linked to a tool result — ' + SOURCE_GONE
              : 'Taken verbatim from a tool result'}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-2xs">
            <dt className="text-ink-subtle">Tool</dt>
            <dd className="min-w-0 font-mono break-all">{provenance.tool || 'not named'}</dd>
            <dt className="text-ink-subtle">Pointer</dt>
            <dd className="min-w-0 font-mono break-all">{provenance.pointer || '/'}</dd>
            <dt className="text-ink-subtle">Result</dt>
            <dd className="min-w-0 font-mono break-all">{shortRef(provenance.result)}</dd>
          </dl>
          {gone && provenance.error && <p className="text-2xs text-warn-ink">{provenance.error}</p>}
          {opened.act ? (
            <div className="flex flex-col gap-1">
              <Button
                variant="outline"
                size="xs"
                className="self-start"
                disabled={detachDisabled}
                onClick={() => {
                  setOpen(false);
                  opened.act?.();
                }}
              >
                <Unlink aria-hidden className="size-3.5" />
                Detach
              </Button>
              <span className="text-2xs text-ink-muted">
                Keeps the value shown as your own and saves a revision; it can then be edited.
              </span>
            </div>
          ) : (
            <span className="text-2xs text-ink-muted">
              Read-only: linked values are not edited.
            </span>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * The bindings of this revision whose source is gone — above the body, like the unverified strip,
 * because a value that reads as a measurement and has lost its source is a qualifier the reader
 * needs before believing it.
 */
export function GoneSourcesStrip({ gone }: { gone: readonly Binding[] }): React.JSX.Element | null {
  if (gone.length === 0) return null;
  const structures = gone.filter(isStructureCitation);
  const results = gone.filter((b) => !isStructureCitation(b));
  return (
    <p
      role="note"
      className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn-ink"
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span className="flex flex-col gap-1">
        {results.length > 0 && (
          <span>
            {results.length === 1 ? 'One linked value: ' : `${results.length} linked values: `}
            {SOURCE_GONE} — the tool result it was taken from has been removed. Where it stood, the
            artefact says “{SOURCE_GONE}” (a chart series draws no points):{' '}
            <span className="font-mono">{results.map((b) => b.path).join(', ')}</span>
          </span>
        )}
        {structures.map((b) => (
          <span key={b.pointer}>
            The stored structure <span className="font-mono break-all">{b.pointer}</span> this
            geometry cites: {SOURCE_GONE}
            {b.error ? ` — ${b.error}` : ''}.
          </span>
        ))}
      </span>
    </p>
  );
}
