/**
 * A diff is only readable once it is grouped.
 *
 * `base.setpoints.temperature_c` and `arms[7].setpoints.temperature_c` are six rows apart in a flat
 * list and mean completely different things — one moved the whole experiment, the other moved one
 * arm — so the grouping is the component, not a decoration on it. What is pinned here is the
 * segmentation rule (which is where a bracket makes it non-obvious) and the two absences, which a
 * blank cell would render as "unchanged".
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { RevisionDiff, groupChanges, topSegment } from '../src/components/RevisionDiff.tsx';
import type { DesignDiff } from '../shared/protocols.ts';

afterEach(cleanup);

describe('topSegment', () => {
  it('cuts at the first separator, bracket included', () => {
    // Splitting on `.` alone leaves `arms[7]` as its own group, which puts every arm in a group of
    // one — the ungrouped list again, with extra brackets.
    expect(topSegment('base.setpoints.temperature_c')).toBe('base');
    expect(topSegment('arms[7].setpoints.temperature_c')).toBe('arms');
    expect(topSegment('layout')).toBe('layout');
  });
});

describe('groupChanges', () => {
  it('groups by document part, keeping first-seen order', () => {
    const grouped = groupChanges([
      { path: 'base.setpoints.temperature_c', kind: 'changed', before: '60', after: '80' },
      { path: 'arms[0].note', kind: 'added', before: '', after: 'repeat' },
      { path: 'base.charge[1].equivalents', kind: 'changed', before: '1.0', after: '1.2' },
    ]);
    expect(grouped.map((g) => g.section)).toEqual(['base', 'arms']);
    expect(grouped[0]?.changes).toHaveLength(2);
  });
});

const diff = (changes: DesignDiff['changes']): DesignDiff => ({
  from_revision: 2,
  to_revision: 3,
  changes,
});

describe('RevisionDiff', () => {
  it('renders one section per document part, with what moved in each', () => {
    render(
      <RevisionDiff
        diff={diff([
          { path: 'base.setpoints.solvent', kind: 'changed', before: 'THF', after: '2-MeTHF' },
          { path: 'arms[3].setpoints.time_h', kind: 'changed', before: '4', after: '16' },
        ])}
      />,
    );

    const base = screen.getByRole('region', { name: 'base changes' });
    expect(within(base).getByText('2-MeTHF')).toBeTruthy();
    expect(within(base).getByText('THF')).toBeTruthy();
    // The arm's change is in its own section, not mixed in with the whole experiment's.
    expect(within(base).queryByText('16')).toBeNull();
    expect(
      within(screen.getByRole('region', { name: 'arms changes' })).getByText('16'),
    ).toBeTruthy();
  });

  it('draws both absences as absences, never as an empty cell', () => {
    // An empty cell reads as "unchanged", which is the opposite of what an add and a remove mean.
    render(
      <RevisionDiff
        diff={diff([
          { path: 'base.hazards[0]', kind: 'added', before: '', after: 'peroxide former' },
          { path: 'base.waste', kind: 'removed', before: 'aqueous', after: '' },
        ])}
      />,
    );
    expect(screen.getByText('not present')).toBeTruthy();
    expect(screen.getByText('removed', { selector: 'span.italic' })).toBeTruthy();
  });

  it('says a revision with no changes is one, rather than showing an empty table', () => {
    render(<RevisionDiff diff={diff([])} />);
    expect(screen.getByText(/hold the same document/)).toBeTruthy();
  });
});
