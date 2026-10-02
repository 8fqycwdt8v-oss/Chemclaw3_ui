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
 * added.
 */

import { useState } from 'react';
import type { StructureItem, StructuresSpec } from '../../../../shared/exhibits.ts';
import { formatScientificNumber } from '../../../lib/format.ts';
import { Molecule } from '../../Molecule.tsx';
import { UseStructure } from '@/components/chem/UseStructure';
import { Sheet, SheetContent } from '@/components/ui/sheet';

const shownProp = (value: string | number): string =>
  typeof value === 'number' ? formatScientificNumber(value) : value;

function Props({ props }: { props: StructureItem['props'] }): React.JSX.Element | null {
  const entries = Object.entries(props);
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-2xs">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-ink-subtle">{key}</dt>
          <dd className="min-w-0 truncate font-mono tabular-nums">{shownProp(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function StructuresView({ spec }: { spec: StructuresSpec }): React.JSX.Element {
  const [enlarged, setEnlarged] = useState<number | null>(null);
  const item = enlarged === null ? null : spec.items[enlarged];

  return (
    <>
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
            <p className="truncate font-mono text-2xs text-ink-muted" title={entry.smiles}>
              {entry.smiles}
            </p>
            <Props props={entry.props} />
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
              <Props props={item.props} />
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
