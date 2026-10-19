/**
 * The conversation's subjects as a rail beside it, populated under `src/chem/entities.ts`'s
 * promotion rule. Selecting an entity filters the transcript to turns that mention it; selecting
 * again clears it. Rows show what tools returned for a structure (`ValueList`), without inventing
 * labels or relationships. Below `lg` the same body is a sheet. There is no pin control: nothing
 * would hold a pinned entity.
 */

import { useState } from 'react';
import { FlaskConical } from 'lucide-react';
import {
  entitiesOf,
  useEntityStore,
  type Entity,
  type JobEntity,
  type Mention,
} from '../chem/entities.ts';
import { formatScientificNumber } from '../lib/format.ts';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { UseStructure } from '@/components/chem/UseStructure';
import { Molecule } from './Molecule.tsx';

/** Past tense, because the provenance line reads as a list of things that happened to the entity —
 *  beside a tool name, "drawn" sits where "predict_pka" would. */
const USER_SOURCE_LABEL: Record<string, string> = {
  paste: 'pasted',
  file: 'from file',
  sketch: 'drawn',
};

const KIND_LABEL: Record<Entity['kind'], string> = {
  molecule: 'Molecules',
  reaction: 'Reactions',
  job: 'Jobs',
  note: 'Notes',
};

/** The order the sections appear in — structures first, because they are what a bench chemist
 *  scans for. */
const KIND_ORDER: Entity['kind'][] = ['molecule', 'reaction', 'job', 'note'];

const JOB_TONE: Record<JobEntity['status'], 'ok' | 'danger' | 'neutral'> = {
  completed: 'ok',
  failed: 'danger',
  running: 'neutral',
};

/** Figures shown per call before "N more"; some tools return about fifty. */
const VALUES_SHOWN = 6;

function JobRow({ entity }: { entity: JobEntity }): React.JSX.Element {
  return (
    <span className="block min-w-0">
      <span className="flex items-center gap-1.5">
        {/* "running" is closed by the push-back stream's ending. */}
        <Badge tone={JOB_TONE[entity.status]}>{entity.status}</Badge>
        <span className="truncate text-xs">{entity.jobKind}</span>
      </span>
      <span className="block truncate font-mono text-2xs text-ink-muted">{entity.jobId}</span>
      {entity.status === 'failed' && entity.reason && (
        <span className="mt-0.5 line-clamp-2 text-2xs text-danger-ink">{entity.reason}</span>
      )}
    </span>
  );
}

/**
 * What tools returned for this structure: one line per tool, naming it; a call on several
 * structures is marked. Figures carry the tool's key and unit when structured, bare otherwise;
 * never combined into a value-with-uncertainty.
 */
function ValueList({ mentions }: { mentions: readonly Mention[] }): React.JSX.Element | null {
  const withValues = mentions.filter((m) => m.tool && (m.values?.length ?? 0) > 0);
  if (withValues.length === 0) return null;

  return (
    <span className="mt-1.5 block border-t border-border-subtle pt-1.5">
      {withValues.map((mention, i) => {
        const named = mention.named ?? [];
        const values = mention.values ?? [];
        const total = named.length || values.length;
        const shownNamed = named.slice(0, VALUES_SHOWN);
        const shown = values.slice(0, VALUES_SHOWN);
        return (
          <span key={`${mention.messageId}-${mention.tool}-${i}`} className="mt-0.5 block">
            <span className="block truncate font-mono text-2xs text-ink-subtle">
              {mention.tool}
            </span>
            <span className="block font-mono text-2xs tabular-nums text-ink-muted">
              {named.length > 0
                ? shownNamed
                    .map(
                      (v) =>
                        `${v.label} ${formatScientificNumber(v.value)}${v.unit ? ` ${v.unit}` : ''}`,
                    )
                    .join(' · ')
                : shown.map((v) => formatScientificNumber(v)).join(', ')}
              {total > VALUES_SHOWN && ` … +${total - VALUES_SHOWN}`}
            </span>
            {mention.shared && (
              <span className="block text-2xs text-ink-subtle">
                one call, several structures — these are the call’s figures
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}

function Row({
  conversationId,
  entity,
  onSelected,
}: {
  conversationId: string;
  entity: Entity;
  /** Called after a subject is selected. The sheet uses it to close: the transcript it just
   *  filtered is behind it. */
  onSelected?: () => void;
}): React.JSX.Element {
  const selected = useEntityStore((s) => entitiesOf(s, conversationId).selected === entity.key);
  const select = useEntityStore((s) => s.select);

  // Which tools touched this row — or, for a structure the chemist supplied themselves, how they
  // supplied it, which is the same question answered from the other side.
  const provenance = [
    ...new Set(
      entity.mentions
        .map((m) => m.tool ?? (m.source ? USER_SOURCE_LABEL[m.source] : undefined))
        .filter(Boolean),
    ),
  ].join(', ');

  const structure =
    entity.kind === 'molecule'
      ? entity.smiles
      : entity.kind === 'reaction'
        ? entity.reactionSmiles
        : null;

  return (
    <li
      className={cn(
        'rounded-md border transition-colors',
        selected ? 'border-brand bg-brand-soft' : 'border-border-subtle bg-surface-raised',
      )}
    >
      {/* Sibling buttons, never nested (a nested button is dropped by the browser). */}
      <button
        type="button"
        onClick={() => {
          select(conversationId, entity.key);
          onSelected?.();
        }}
        aria-pressed={selected}
        className={cn(
          'block w-full rounded-t-md p-2 text-left',
          !selected && 'hover:bg-surface-sunken',
          'focus-ring',
        )}
      >
        {entity.kind === 'molecule' && (
          <>
            <Molecule smiles={entity.smiles} maxWidth={180} />
            <span
              className="block truncate font-mono text-2xs text-ink-muted"
              title={entity.smiles}
            >
              {entity.smiles}
            </span>
          </>
        )}
        {entity.kind === 'reaction' && <Molecule smiles={entity.reactionSmiles} maxWidth={180} />}
        {entity.kind === 'job' && <JobRow entity={entity} />}
        {entity.kind === 'note' && (
          <span className="block truncate font-mono text-xs">{entity.noteId}</span>
        )}

        <span className="mt-1 block truncate text-2xs text-ink-subtle">{provenance || '—'}</span>
        <ValueList mentions={entity.mentions} />
      </button>

      {structure && (
        <div className="flex justify-end px-2 pb-2">
          <UseStructure smiles={structure} />
        </div>
      )}
    </li>
  );
}

/** The rail's contents, shared by the column, the sheet and the artefact pane's Index tab. */
export function RailBody({
  conversationId,
  onSelected,
}: {
  conversationId: string;
  onSelected?: () => void;
}): React.JSX.Element | null {
  // One subscription to this conversation's slice; `NO_ENTITIES` is a shared constant, so empty
  // conversations are stable.
  const slice = useEntityStore((s) => entitiesOf(s, conversationId));
  const select = useEntityStore((s) => s.select);
  const { entities, order, selected } = slice;

  const all = order.map((key) => entities[key]).filter((e): e is Entity => Boolean(e));
  if (all.length === 0) return null;

  return (
    <>
      {selected && (
        <Button
          variant="outline"
          size="xs"
          className="mb-2 w-full"
          onClick={() => select(conversationId, null)}
        >
          Showing one subject — clear
        </Button>
      )}

      {KIND_ORDER.map((kind) => {
        const rows = all.filter((e) => e.kind === kind);
        if (rows.length === 0) return null;
        return (
          <section key={kind} className="mb-3">
            <h2 className="mb-1.5 text-2xs font-medium tracking-wide text-ink-subtle uppercase">
              {KIND_LABEL[kind]} ({rows.length})
            </h2>
            <ul className="space-y-1.5">
              {rows.map((entity) => (
                <Row
                  key={entity.key}
                  conversationId={conversationId}
                  entity={entity}
                  onSelected={onSelected}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

/** How many subjects this conversation has. Drives whether the rail exists at all. */
export function useSubjectCount(conversationId: string): number {
  return useEntityStore((s) => entitiesOf(s, conversationId).order.length);
}

export function EntityRail({
  conversationId,
}: {
  /** The conversation whose index this is, named explicitly (see `src/chem/entities.ts`). */
  conversationId: string;
}): React.JSX.Element | null {
  const count = useSubjectCount(conversationId);
  // Nothing at all when empty.
  if (count === 0) return null;

  return (
    <aside
      aria-label="What this conversation is about"
      className="hidden w-56 shrink-0 flex-col overflow-y-auto border-l border-border-subtle bg-surface-sunken p-3 lg:flex"
    >
      <RailBody conversationId={conversationId} />
    </aside>
  );
}

/**
 * The rail as a sheet on narrow screens, triggered from the top bar; the trigger hides when the
 * rail is empty.
 */
export function EntityRailTrigger({
  conversationId,
}: {
  conversationId: string;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const count = useSubjectCount(conversationId);
  if (count === 0) return null;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`What this conversation is about (${count})`}
          className="lg:hidden"
        >
          <FlaskConical />
        </Button>
      </SheetTrigger>
      <SheetContent side="right" title="What this conversation is about" className="w-72 p-0">
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 pt-10">
          {/* Close the sheet on select: the filtered transcript is behind it. */}
          <RailBody conversationId={conversationId} onSelected={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
