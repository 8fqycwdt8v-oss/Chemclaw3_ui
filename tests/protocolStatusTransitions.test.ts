/**
 * The sign-off panel's filter over the lifecycle core publishes on `StatusIn`
 * (`shared/generated/lifecycle.ts`). That the published rules are the enforced ones is core's test
 * (`tests/test_published_lifecycle.py`); this holds the filter that reads them.
 */

import { describe, expect, it } from 'vitest';
import {
  DESIGN_STATUSES,
  LEGAL_STATUS_MOVES,
  STATUSES_NEEDING_A_PROTOCOL,
  STATUSES_REFUSING_A_PROTOCOL,
  legalStatusMoves,
  type DesignStatus,
} from '../shared/protocols.ts';

describe('the design lifecycle this repository draws buttons from', () => {
  it('has a row for every status and names only statuses', () => {
    // Or `legalStatusMoves` indexes a hole and the panel silently offers nothing, which reads on
    // screen exactly like a design with no moves left.
    expect(Object.keys(LEGAL_STATUS_MOVES).sort()).toEqual([...DESIGN_STATUSES].sort());
    for (const [from, targets] of Object.entries(LEGAL_STATUS_MOVES)) {
      const listed: readonly string[] = targets;
      expect(listed).not.toContain(from as DesignStatus);
      for (const target of targets) expect(DESIGN_STATUSES).toContain(target);
    }
  });

  it('offers a draft only the two moves the service will take', () => {
    // The whole point, in one assertion: `draft -> requested` and `draft -> executed` are 422s, and
    // this panel used to render a button for both.
    expect(legalStatusMoves('draft', 'protocol')).toEqual(['approved', 'abandoned']);
  });

  it('withholds a status that asserts a procedure from a design that has none', () => {
    // `require_movable`'s first rule, which outranks the table: a design holding only the
    // structured ask cannot be approved or executed, whatever it is currently.
    expect(legalStatusMoves('draft', 'request')).toEqual(['abandoned']);
    expect(legalStatusMoves('approved', 'request')).toEqual(['draft', 'abandoned']);
    for (const status of STATUSES_NEEDING_A_PROTOCOL) {
      for (const from of DESIGN_STATUSES) {
        expect(legalStatusMoves(from, 'request')).not.toContain(status);
      }
    }
  });

  it('never offers `requested` back to a design that holds a procedure', () => {
    // `require_movable`'s second rule. The table already excludes `requested` as a target
    // everywhere, so this asserts the two rules agree rather than that either one works alone.
    for (const from of DESIGN_STATUSES) {
      expect(legalStatusMoves(from, 'protocol')).not.toContain('requested');
      expect(legalStatusMoves(from, 'request')).not.toContain('requested');
    }
  });

  it('never offers a status a procedure refutes to a design that holds one', () => {
    for (const status of STATUSES_REFUSING_A_PROTOCOL) {
      for (const from of DESIGN_STATUSES) {
        expect(legalStatusMoves(from, 'protocol')).not.toContain(status);
      }
    }
  });
});
