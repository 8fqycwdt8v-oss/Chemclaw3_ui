/**
 * The design lifecycle this repository draws buttons from.
 *
 * `shared/protocols.ts` carries `LEGAL_STATUS_MOVES` and `STATUSES_NEEDING_A_PROTOCOL` because the
 * sign-off panel has to decide which buttons can succeed *before* it draws them, and there is no
 * route that answers that question: `require_movable` refuses a move and never publishes the set
 * it refused from. The table is therefore a second definition of something core owns that the
 * pinned contract does not carry (`ISSUES.md`, "The design lifecycle is a transcription"). What is
 * held here is what needs no service: that the table is total, closed, and consistent with the
 * filter the panel actually calls.
 */

import { describe, expect, it } from 'vitest';
import {
  DESIGN_STATUSES,
  LEGAL_STATUS_MOVES,
  STATUSES_NEEDING_A_PROTOCOL,
  legalStatusMoves,
  type DesignStatus,
} from '../shared/protocols.ts';

describe('the design lifecycle this repository draws buttons from', () => {
  it('has a row for every status and names only statuses', () => {
    // Or `legalStatusMoves` indexes a hole and the panel silently offers nothing, which reads on
    // screen exactly like a design with no moves left.
    expect(Object.keys(LEGAL_STATUS_MOVES).sort()).toEqual([...DESIGN_STATUSES].sort());
    for (const [from, targets] of Object.entries(LEGAL_STATUS_MOVES)) {
      expect(targets).not.toContain(from as DesignStatus);
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
});
