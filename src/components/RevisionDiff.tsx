/**
 * What changed between two revisions of a design.
 *
 * A flat list of thirty changed paths is a list nobody reads: `base.setpoints.temperature_c` and
 * `arms[7].setpoints.temperature_c` sit six rows apart and mean completely different things — one
 * moved the whole experiment, the other moved one arm. Grouping by the top-level segment is what
 * turns the list into an answer to the question a reviewer actually asks, which is *what part of
 * this document moved*: the request, the base protocol, the factors, the arms, the layout, the
 * evidence.
 *
 * `before` and `after` arrive already rendered as text — the service does the formatting, because
 * it is the side that knows a `null` from an empty string and a mole from a millimole — so nothing
 * here re-formats them. An added field has no `before` and a removed one has no `after`, and both
 * are drawn as an explicit absence rather than as an empty cell, which would read as "unchanged".
 */

import type { DesignDiff, FieldChange } from '../../shared/protocols.ts';
import { Badge } from '@/components/ui/badge';

const KIND_TONE: Record<FieldChange['kind'], 'ok' | 'danger' | 'warn'> = {
  added: 'ok',
  removed: 'danger',
  changed: 'warn',
};

/**
 * The document part a path belongs to.
 *
 * `arms[7].setpoints.temperature_c` → `arms`; `base.setpoints.solvent` → `base`. Splitting on the
 * first `.` alone would leave `arms[7]` as its own group and put every arm in a group of one,
 * which is the ungrouped list again with extra brackets.
 */
export function topSegment(path: string): string {
  const cut = path.search(/[.[]/);
  const head = cut === -1 ? path : path.slice(0, cut);
  return head || path;
}

/** The changes, grouped by the part of the document they touch, in first-seen order. */
export function groupChanges(
  changes: FieldChange[],
): { section: string; changes: FieldChange[] }[] {
  const groups = new Map<string, FieldChange[]>();
  for (const change of changes) {
    const section = topSegment(change.path);
    const existing = groups.get(section);
    if (existing) existing.push(change);
    else groups.set(section, [change]);
  }
  return [...groups].map(([section, list]) => ({ section, changes: list }));
}

function Value({ text, absent }: { text: string; absent: string }): React.JSX.Element {
  if (text === '') return <span className="text-ink-subtle italic">{absent}</span>;
  return <span className="font-mono text-2xs break-words">{text}</span>;
}

export function RevisionDiff({ diff }: { diff: DesignDiff }): React.JSX.Element {
  const groups = groupChanges(diff.changes);

  if (groups.length === 0) {
    return (
      <p className="rounded-lg border border-border-subtle bg-surface-sunken px-3 py-2 text-sm">
        Revision {diff.from_revision} and revision {diff.to_revision} hold the same document. A
        revision with no changes is normally one written only to record a change note.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-muted">
        {diff.changes.length} change{diff.changes.length === 1 ? '' : 's'} from revision{' '}
        {diff.from_revision} to revision {diff.to_revision}, grouped by the part of the document
        each touches.
      </p>

      {groups.map((group) => (
        <section key={group.section} aria-label={`Changes to ${group.section}`}>
          <h4 className="mb-1.5 flex items-center gap-2 text-2xs font-medium tracking-wide text-ink-subtle uppercase">
            {group.section}
            <Badge tone="neutral">{group.changes.length}</Badge>
          </h4>
          <div
            tabIndex={0}
            role="region"
            aria-label={`${group.section} changes`}
            className="overflow-x-auto rounded-lg border border-border-subtle focus-ring"
          >
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-sunken text-2xs tracking-wide text-ink-subtle uppercase">
                <tr>
                  <th scope="col" className="px-2.5 py-2 font-medium whitespace-nowrap">
                    Field
                  </th>
                  <th scope="col" className="px-2.5 py-2 font-medium whitespace-nowrap">
                    Before
                  </th>
                  <th scope="col" className="px-2.5 py-2 font-medium whitespace-nowrap">
                    After
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {group.changes.map((change, i) => (
                  <tr key={`${change.path}-${i}`}>
                    <td className="px-2.5 py-1.5 align-top">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={KIND_TONE[change.kind]}>{change.kind}</Badge>
                        <span className="font-mono text-2xs break-all">{change.path}</span>
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5 align-top">
                      <Value text={change.before} absent="not present" />
                    </td>
                    <td className="px-2.5 py-1.5 align-top">
                      <Value text={change.after} absent="removed" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
