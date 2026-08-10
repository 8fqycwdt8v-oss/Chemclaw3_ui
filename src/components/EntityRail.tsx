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
 * **There is no pin control**, and its absence is deliberate rather than pending. The branch this
 * comes from had one, and what it did was toggle a boolean that changed the pin's own colour:
 * nothing rendered a pinned entity anywhere else, so "hold two candidates side by side" was a
 * promise the button did not keep. A control that looks like a feature and is a no-op costs more
 * trust than the missing feature does, so it is left out until there is a place for a pinned
 * structure to be held.
 */

import { entitiesOf, useEntityStore, type Entity, type JobEntity } from '../chem/entities.ts';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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

function Row({
  conversationId,
  entity,
}: {
  conversationId: string;
  entity: Entity;
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

  return (
    <li>
      <button
        type="button"
        onClick={() => select(conversationId, entity.key)}
        aria-pressed={selected}
        className={cn(
          'block w-full rounded-md border p-2 text-left transition-colors focus-ring',
          selected
            ? 'border-brand bg-brand-soft'
            : 'border-border-subtle bg-surface-raised hover:border-border-strong',
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
      </button>
    </li>
  );
}

export function EntityRail({
  conversationId,
}: {
  /** The conversation whose index this is. Named rather than read off an "active conversation"
   *  pointer, so the rail cannot describe one conversation while the transcript beside it
   *  describes another — see `src/chem/entities.ts`. */
  conversationId: string;
}): React.JSX.Element | null {
  // One subscription to the conversation's whole slice. Its identity changes only when *this*
  // conversation ingests something, and `NO_ENTITIES` is a shared constant, so a conversation with
  // no entities does not mint a new snapshot on every render.
  const slice = useEntityStore((s) => entitiesOf(s, conversationId));
  const select = useEntityStore((s) => s.select);
  const { entities, order, selected } = slice;

  const all = order.map((key) => entities[key]).filter((e): e is Entity => Boolean(e));
  // Nothing at all rather than an empty panel: a rail that reserves a sixth of the width to say
  // "no subjects yet" is worse than the space it takes, and a fresh conversation is every
  // conversation's first state.
  if (all.length === 0) return null;

  return (
    <aside
      aria-label="What this conversation is about"
      className="hidden w-56 shrink-0 flex-col overflow-y-auto border-l border-border-subtle bg-surface-sunken p-3 lg:flex"
    >
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
                <Row key={entity.key} conversationId={conversationId} entity={entity} />
              ))}
            </ul>
          </section>
        );
      })}
    </aside>
  );
}
