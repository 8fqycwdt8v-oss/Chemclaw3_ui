/**
 * A structures artefact: a grid of molecules, each with its label and its properties.
 *
 * Drawn here, from SMILES, by the RDKit WASM this app already ships — never an SVG the model or the
 * service produced. That was half the argument for the kind: `render_structure` returns ~35 kB of
 * SVG per drug-sized molecule *into the model's context*, and the chemist only ever needed the
 * picture, which this browser can draw for nothing.
 *
 * A SMILES RDKit cannot read is shown as the string it is, by `Molecule`'s own fallback, rather
 * than dropped: the service already checked every SMILES parses, so an unreadable one here is this
 * browser's toolkit failing to load, and the string is still the record.
 *
 * Selecting a tile enlarges it in a panel with the whole SMILES, every property and "use in my
 * message". Properties are the agent's literal values, shown with the key it wrote and no unit
 * added — or, since wave 3, values bound to a tool result: a bound SMILES or property carries a
 * provenance marker, and **Detach** (from the marker, on the head) is the one write this view makes.
 */

import { useState } from 'react';
import type { ExhibitView, StructureItem, StructuresSpec } from '../../../../shared/exhibits.ts';
import { formatScientificNumber } from '../../../lib/format.ts';
import { Molecule } from '../../Molecule.tsx';
import { UseStructure } from '@/components/chem/UseStructure';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { ProvenanceMarker, SOURCE_GONE } from '../Provenance.tsx';
import { ReviseNotices } from '../ReviseNotices.tsx';
import { useRevise } from '../useRevise.ts';
import {
  canDetach,
  detach,
  pathOf,
  provenanceAt,
  rawOf,
  type BoundTarget,
  type Provenance,
} from '../bindings.ts';

/** A property as text; `null` is a bound value whose source is gone, said rather than blanked. */
const shownProp = (value: string | number | null): string =>
  value === null ? SOURCE_GONE : typeof value === 'number' ? formatScientificNumber(value) : value;

/** What a bound position needs to draw its marker: the provenance, and the detach if offered. */
type MarkerFor = (target: BoundTarget) => React.JSX.Element | null;

function Props({
  item,
  props,
  marker,
}: {
  item: number;
  props: StructureItem['props'];
  marker: MarkerFor;
}): React.JSX.Element | null {
  const entries = Object.entries(props);
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-2xs">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-ink-subtle">{key}</dt>
          <dd className="flex min-w-0 items-center gap-1 font-mono tabular-nums">
            <span className="truncate">{shownProp(value)}</span>
            {marker({ at: 'prop', item, name: key })}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function StructuresView({
  sessionId,
  view,
  spec,
  isHead,
}: {
  sessionId: string;
  view: ExhibitView;
  spec: StructuresSpec;
  isHead: boolean;
}): React.JSX.Element {
  const [enlarged, setEnlarged] = useState<number | null>(null);
  const item = enlarged === null ? null : spec.items[enlarged];
  const revise = useRevise(sessionId, view);
  const raw = rawOf(view, 'structures');

  const detachFor = (target: BoundTarget, provenance: Provenance): (() => void) | undefined => {
    if (!isHead || !raw || !canDetach(target, provenance)) return undefined;
    const base = view.revision;
    return () => {
      const next = detach(raw, spec, target);
      if (next) void revise.save(next, `Detached ${pathOf(target)} from its tool result`, base);
    };
  };
  const marker: MarkerFor = (target) => {
    const bound = provenanceAt(view, target);
    return bound ? (
      <ProvenanceMarker
        provenance={bound}
        onDetach={detachFor(target, bound)}
        detachDisabled={revise.state.status === 'saving'}
      />
    ) : null;
  };

  return (
    <>
      <ReviseNotices sessionId={sessionId} exhibitId={view.exhibit_id} revise={revise} />
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-2">
        {spec.items.map((entry, index) => (
          <li
            key={`${entry.smiles}-${index}`}
            className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-surface-raised p-2"
          >
            <button
              type="button"
              onClick={() => setEnlarged(index)}
              aria-label={`Enlarge ${entry.label || entry.smiles}`}
              className="rounded-md hover:bg-surface-sunken focus-ring"
            >
              <Molecule smiles={entry.smiles} maxWidth={180} />
            </button>
            {entry.label && <p className="truncate text-xs font-medium">{entry.label}</p>}
            <p className="flex min-w-0 items-center gap-1 font-mono text-2xs text-ink-muted">
              <span className="truncate" title={entry.smiles}>
                {entry.smiles || SOURCE_GONE}
              </span>
              {marker({ at: 'smiles', item: index })}
            </p>
            <Props item={index} props={entry.props} marker={marker} />
          </li>
        ))}
      </ul>

      <Sheet
        open={item !== null && item !== undefined}
        onOpenChange={(open) => !open && setEnlarged(null)}
      >
        <SheetContent
          side="right"
          title={item ? item.label || item.smiles : 'Structure'}
          className="w-[min(36rem,95vw)]"
        >
          {item && (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5 pt-10">
              {item.label && <h3 className="font-medium">{item.label}</h3>}
              <Molecule smiles={item.smiles} maxWidth={520} />
              <p className="font-mono text-xs break-all text-ink-muted">{item.smiles}</p>
              <Props item={enlarged ?? 0} props={item.props} marker={marker} />
              <div className="flex justify-end">
                <UseStructure smiles={item.smiles} label onUsed={() => setEnlarged(null)} />
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
