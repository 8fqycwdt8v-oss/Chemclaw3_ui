/**
 * The design lifecycle this repository draws buttons from, against the service that owns it.
 *
 * `shared/protocols.ts` carries `LEGAL_STATUS_MOVES` and `STATUSES_NEEDING_A_PROTOCOL` because the
 * sign-off panel has to decide which buttons can succeed *before* it draws them, and there is no
 * route that answers that question: `require_movable` refuses a move and never publishes the set
 * it refused from. The pinned contract does not carry it either, so the table is a second
 * definition of something core owns (`ISSUES.md`, "The design lifecycle is a transcription").
 *
 * Two halves. What needs no service always runs: the table is total, closed, and consistent with
 * the filter the panel calls. The cross-repository half reads
 * `src/chemclaw/protocols/store.py` **at the commit `contracts/core.lock` pins** (never core's
 * `main`) through the contract check's reader, and fails on any difference in either direction. It
 * is parsed, not executed: it proves the literals match, and the 422 landing in the document's
 * alert block is the cover for anything the service enforces in a shape this cannot see. With
 * `CHEMCLAW3_REQUIRED=1` — the pipelines — an unreadable store is a failure; without it the half is
 * skipped out loud.
 */

import { describe, expect, it } from 'vitest';
import { coreFileAtPin } from '../scripts/contract-check.mjs';
import { readLock } from '../scripts/lib/contractLock.mjs';
import {
  DESIGN_STATUSES,
  LEGAL_STATUS_MOVES,
  STATUSES_NEEDING_A_PROTOCOL,
  legalStatusMoves,
  type DesignStatus,
} from '../shared/protocols.ts';

const STORE = 'src/chemclaw/protocols/store.py';
const REQUIRED = process.env.CHEMCLAW3_REQUIRED === '1';
const core = coreFileAtPin(readLock(), REQUIRED, STORE);
const source = 'text' in core ? core.text : null;
if (source === null) {
  console.warn(
    `[protocol transitions] NOT CHECKED against the service: ${(core as { problem: string }).problem}.`,
  );
}

/** The members of a Python `frozenset({...})` or list literal, as strings. */
const members = (literal: string): string[] =>
  [...literal.matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1] as string);

/** `_LEGAL_MOVES` as the service declares it. */
function serviceTable(text: string): Record<string, string[]> {
  const block = /_LEGAL_MOVES[^=]*=\s*\{([\s\S]*?)\n\}/.exec(text);
  expect(block, '_LEGAL_MOVES is no longer a dict literal in the service').not.toBeNull();
  const rows: Record<string, string[]> = {};
  for (const row of [
    ...(block?.[1] ?? '').matchAll(/["'](\w+)["']\s*:\s*frozenset\(\{([^}]*)\}\)/g),
  ]) {
    rows[row[1] as string] = members(row[2] as string);
  }
  return rows;
}

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

  it('is a failure rather than a skip in a lane that says it has the checkout', () => {
    expect(
      source !== null || !REQUIRED,
      `CHEMCLAW3_REQUIRED=1, and ${STORE} could not be read at the pinned commit`,
    ).toBe(true);
  });

  describe.skipIf(source === null)('against the service at the pinned commit', () => {
    const text = source ?? '';

    it('matches `_LEGAL_MOVES`, edge for edge', () => {
      const sorted = (rows: Record<string, readonly string[]>) =>
        Object.fromEntries(Object.entries(rows).map(([from, to]) => [from, [...to].sort()]));
      expect(sorted(serviceTable(text))).toEqual(sorted(LEGAL_STATUS_MOVES));
    });

    it('matches `_NEEDS_A_PROTOCOL`, which outranks the table', () => {
      const declared = /_NEEDS_A_PROTOCOL[^=]*=\s*frozenset\(\{([^}]*)\}\)/.exec(text);
      expect(declared, '_NEEDS_A_PROTOCOL is no longer a frozenset literal').not.toBeNull();
      expect(members(declared?.[1] ?? '').sort()).toEqual([...STATUSES_NEEDING_A_PROTOCOL].sort());
    });

    it('still refuses `requested` on a protocol head, which is the rule with no table row', () => {
      // An `if` in the service rather than a set, so there is nothing to diff: this checks the
      // branch exists. Deleted there, the filter here narrows what the service does not.
      expect(text).toMatch(/status == "requested" and head_kind == "protocol"/);
    });
  });
});
