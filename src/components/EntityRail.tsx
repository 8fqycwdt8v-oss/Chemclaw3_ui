/**
 * The conversation's subjects, as a rail beside it.
 *
 * What this is for: after twenty exchanges about a coupling, "which bromide were we using" is a
 * scroll. The transcript indexes what was *said*; this indexes what the conversation is *about* —
 * and it pays off exactly when a chat UI otherwise degrades, which is when the conversation gets
 * long.
 *
 * Selecting an entity filters the transcript to the turns that mention it. Pinning holds a
 * structure open while you scroll, so two candidates can be compared side by side without either
 * of them being the thing you happen to be looking at.
 *
 * Everything here is populated under `src/chem/entities.ts`'s promotion rule — structured sources
 * only. A rail full of near-misses is worse than no rail, because a chemist stops reading it and
 * then misses the one row that mattered.
 */

import {
  entitiesOf,
  useEntityStore,
  type Entity,
  type JobEntity,
  type MoleculeEntity,
  type UserStructureSource,
} from '../chem/entities.ts';
import { cn } from '../lib/cn.ts';
import { Molecule, Reaction } from './Molecule.tsx';

/** Past tense, because the provenance line reads as a list of things that happened to the entity —
 *  beside a tool name, "drawn" sits where "predict_pka" would. */
const USER_SOURCE_LABEL: Record<UserStructureSource, string> = {
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

function JobRow({ entity }: { entity: JobEntity }): React.JSX.Element {
  const tone =
    entity.status === 'failed'
      ? 'bg-danger-soft text-danger'
      : entity.status === 'completed'
        ? 'bg-ok-soft text-ok'
        : 'bg-surface-sunken text-ink-muted';

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <span className={cn('rounded px-1.5 py-0.5 text-[10px]', tone)}>
          {/* "running" is a claim this row is entitled to make only because the push-back stream
              closes it — before `job_failed` was read, it was a claim that never expired. */}
          {entity.status}
        </span>
        <span className="truncate text-xs">{entity.jobKind}</span>
      </div>
      <p className="truncate font-mono text-[10px] text-ink-muted">{entity.jobId}</p>
      {entity.status === 'failed' && entity.reason && (
        <p className="mt-0.5 line-clamp-2 text-[10px] text-danger">{entity.reason}</p>
      )}
    </div>
  );
}

function MoleculeRow({ entity }: { entity: MoleculeEntity }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <Molecule smiles={entity.smiles} width={150} height={100} />
      <p className="truncate font-mono text-[10px] text-ink-muted" title={entity.smiles}>
        {entity.smiles}
      </p>
    </div>
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
  const pinned = useEntityStore((s) => entitiesOf(s, conversationId).pinned.includes(entity.key));
  const select = useEntityStore((s) => s.select);
  const togglePin = useEntityStore((s) => s.togglePin);

  return (
    <li
      className={cn(
        'group relative rounded-md border p-2',
        selected ? 'border-accent bg-surface-raised' : 'border-border-subtle bg-surface-raised',
      )}
    >
      <button
        type="button"
        onClick={() => select(conversationId, entity.key)}
        aria-pressed={selected}
        className="w-full text-left focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      >
        {entity.kind === 'molecule' && <MoleculeRow entity={entity} />}
        {entity.kind === 'reaction' && (
          <Reaction reactionSmiles={entity.reactionSmiles} width={70} height={55} />
        )}
        {entity.kind === 'job' && <JobRow entity={entity} />}
        {entity.kind === 'note' && (
          <span className="block truncate font-mono text-[11px]">{entity.noteId}</span>
        )}
      </button>

      <div className="mt-1 flex items-center justify-between">
        {/* Why this row is here, in the smallest useful form: which tools touched it — or, for a
            structure the chemist supplied themselves, how they supplied it, which is the same
            question answered from the other side. */}
        <span className="truncate text-[10px] text-ink-muted">
          {[
            ...new Set(
              entity.mentions
                .map((m) => m.tool ?? (m.source ? USER_SOURCE_LABEL[m.source] : undefined))
                .filter(Boolean),
            ),
          ].join(', ') || '—'}
        </span>
        <button
          type="button"
          onClick={() => togglePin(conversationId, entity.key)}
          aria-label={pinned ? `Unpin ${entity.key}` : `Pin ${entity.key}`}
          className={cn(
            'rounded px-1 text-[10px]',
            pinned ? 'text-accent' : 'text-ink-muted opacity-0 group-hover:opacity-100',
          )}
        >
          {pinned ? '📌' : 'pin'}
        </button>
      </div>
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
  if (all.length === 0) return null;

  return (
    <aside
      aria-label="What this conversation is about"
      className="flex w-56 shrink-0 flex-col overflow-y-auto border-l border-border-subtle bg-surface-sunken p-3"
    >
      {selected && (
        <button
          type="button"
          onClick={() => select(conversationId, null)}
          className="mb-2 rounded border border-border-subtle px-2 py-1 text-xs text-ink-muted hover:text-ink"
        >
          Showing turns about one subject — clear
        </button>
      )}

      {KIND_ORDER.map((kind) => {
        const rows = all.filter((e) => e.kind === kind);
        if (rows.length === 0) return null;
        return (
          <section key={kind} className="mb-3">
            <h2 className="mb-1.5 text-[10px] font-medium tracking-wide text-ink-muted uppercase">
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
