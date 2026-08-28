/**
 * The conversation's subjects, as a rail beside it.
 *
 * What this is for: after twenty exchanges about a coupling, "which bromide were we using" is a
 * scroll. The transcript indexes what was *said*; this indexes what the conversation is *about* —
 * and it pays off exactly when a chat UI otherwise degrades, which is when the conversation gets
 * long.
 *
 * Selecting an entity filters the transcript to the turns that mention it; selecting it again
 * clears the filter.
 *
 * Everything here is populated under `src/chem/entities.ts`'s promotion rule — structured sources
 * only. A rail full of near-misses is worse than no rail, because a chemist stops reading it and
 * then misses the one row that mattered.
 *
 * ## It shows the values now, which is what the toolkit was bought for
 *
 * `src/chem/rdkit.ts` justifies a 6.9 MB dependency on three grounds, and the first is that
 * canonical identity lets the rail "join a computed value to the structure it was computed for".
 * The key collapsed the spellings and nothing was ever attached to it: a row was a drawing, a
 * SMILES and a comma-joined list of tool names. `ValueList` is the other half.
 *
 * It is deliberately unglamorous, because `tool_result.numbers` carries no labels and no units.
 * "predict_pka returned 4.76, 1.6" is the whole of what can truthfully be said — dressing it up as
 * "pKa = 4.76 ± 1.6" would invent an order the wire does not promise and a meaning it does not
 * carry. The method badge and its caveat live one click away in the trace, which is where a reader
 * who wants more than the figures should end up.
 *
 * ## Below `lg` it is a sheet, not an absence
 *
 * It used to be `hidden … lg:flex` with no replacement, so on a tablet or a phone the structures,
 * the jobs, the notes and the transcript filter simply did not exist. `Sidebar`'s own docstring
 * records the last time this pattern shipped here — it took the conversation switcher and the
 * recovery control off phones, and calls it "the sharpest edge in the product". The fix is the same
 * one: share the body between a persistent column and a Sheet, so there is one implementation and
 * the small screen cannot quietly drift from the large one.
 *
 * **There is no pin control**, and its absence is deliberate rather than pending. The branch this
 * comes from had one, and what it did was toggle a boolean that changed the pin's own colour:
 * nothing rendered a pinned entity anywhere else, so "hold two candidates side by side" was a
 * promise the button did not keep. A control that looks like a feature and is a no-op costs more
 * trust than the missing feature does, so it is left out until there is a place for a pinned
 * structure to be held.
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

/** How many figures to show per call before saying how many more there are. A property tool
 *  returns two or three; `compute_electronic_properties` returns about fifty, and a rail row is
 *  not where fifty numbers become legible. */
const VALUES_SHOWN = 6;

function JobRow({ entity }: { entity: JobEntity }): React.JSX.Element {
  return (
    <span className="block min-w-0">
      <span className="flex items-center gap-1.5">
        {/* "running" is a claim this row is entitled to make only because the push-back stream
            closes it — before `job_failed` was read, it was a claim that never expired. */}
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
 * What the tools returned for this structure.
 *
 * One line per tool that returned anything, naming the tool — a number whose method is unnamed is
 * the failure this whole repo is arranged against. A call that named several structures is marked,
 * because the same figures are attached to each of them.
 *
 * Each figure carries the key the tool filed it under, and its unit where the payload stated one
 * (`tool_result.values`). Where the result was not JSON there are no names, and the row falls back
 * to the bare figures rather than guessing — see `Mention.values`, which is also where the rule
 * that survives the names is written: `pka 4.76` and `sd 1.6` are two values, and nothing here may
 * render them as one measurement with an uncertainty.
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
      {/* The filter button and the "use this" control are SIBLINGS, not nested. A button inside a
          button is invalid, and the browser resolves it by dropping one — which is a control that
          silently does nothing, the exact shape of the pin this rail deleted. */}
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

/** The rail's contents. Shared by the persistent column and the sheet, so the two cannot drift. */
function RailBody({
  conversationId,
  onSelected,
}: {
  conversationId: string;
  onSelected?: () => void;
}): React.JSX.Element | null {
  // One subscription to the conversation's whole slice. Its identity changes only when *this*
  // conversation ingests something, and `NO_ENTITIES` is a shared constant, so a conversation with
  // no entities does not mint a new snapshot on every render.
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
function useSubjectCount(conversationId: string): number {
  return useEntityStore((s) => entitiesOf(s, conversationId).order.length);
}

export function EntityRail({
  conversationId,
}: {
  /** The conversation whose index this is. Named rather than read off an "active conversation"
   *  pointer, so the rail cannot describe one conversation while the transcript beside it
   *  describes another — see `src/chem/entities.ts`. */
  conversationId: string;
}): React.JSX.Element | null {
  const count = useSubjectCount(conversationId);
  // Nothing at all rather than an empty panel: a rail that reserves a sixth of the width to say
  // "no subjects yet" is worse than the space it takes, and a fresh conversation is every
  // conversation's first state.
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
 * The same rail, on a screen too narrow to hold it beside the transcript.
 *
 * Rendered by the top bar rather than by the shell, for the same reason the conversation drawer's
 * trigger is: a control belongs where a reader looks for controls, and the transcript has no chrome
 * of its own on a phone.
 *
 * The trigger disappears with the rail's own emptiness rule, so nobody is ever offered a button
 * that opens a drawer with nothing in it.
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
          {/* Selecting a subject filters the transcript, which is *behind* this sheet — so the
              sheet gets out of the way rather than leaving a chemist to dismiss it and wonder
              whether the tap registered. */}
          <RailBody conversationId={conversationId} onSelected={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
