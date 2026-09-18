// @vitest-environment node

/**
 * This repository's copy of the design lifecycle, against the service that owns it.
 *
 * `shared/protocols.ts` carries `LEGAL_STATUS_MOVES` and `STATUSES_NEEDING_A_PROTOCOL` because the
 * sign-off panel has to decide which buttons can succeed *before* it draws them, and there is no
 * route that answers that question. So the table is a second definition of something the service
 * owns — the same debt `shared/events.ts` and `server/routes.ts` carry, and the same one
 * `scripts/check-openapi.mjs` exists to service.
 *
 * Where those two are checked against a **running** service, this one is checked against the
 * service's **source**, because a transition table is not on the wire: `require_movable` refuses a
 * move and never publishes the set it refused from. So this reads
 * `src/chemclaw/protocols/store.py` out of a sibling checkout and fails on any difference in
 * either direction.
 *
 * **Where that checkout is, is one question with one answer, and the answer is not written here.**
 * It was, and having it written here twice is what made it two answers: this file resolved
 * `CHEMCLAW3_DIR`, else `CHEMCLAW_REPO`, else `../Chemclaw3` relative to this tree's root, while
 * `tests/backendContract.ts` resolved `CHEMCLAW3_DIR`, else `../Chemclaw3` relative to the working
 * directory. Driven on `0fca446` with `CHEMCLAW_REPO` naming a real checkout and no sibling at the
 * default path: this file ran all 8 of its tests against the service in the same run in which the
 * contract check printed “NOT CHECKED”. Both now call `backendCheckout`, each passing the file it
 * opens, because the Jenkins lane's checkout is sparse and the marker one reader needs is not the
 * marker another does.
 *
 * **When there is no checkout, this file says so and does not pretend.** The cross-repo half is
 * skipped and reported as skipped, exactly as `check-openapi.mjs` prints its gap rather than a
 * pass: a check that reports success it did not perform is worse than no check — and
 * `CHEMCLAW3_REQUIRED=1` turns that skip into a failure, which is the same promise the other
 * cross-repository reader makes to the same lane. What still runs everywhere is the half that
 * needs no service — that the table is total, closed, and consistent with the filter the panel
 * actually calls.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backendCheckout, backendSearchPath, checkoutRequired } from './backendContract.ts';
import {
  DESIGN_STATUSES,
  LEGAL_STATUS_MOVES,
  STATUSES_NEEDING_A_PROTOCOL,
  legalStatusMoves,
  type DesignStatus,
} from '../shared/protocols.ts';

/** The one file this reader opens out of that checkout, and the marker that proves it is there. */
const STORE_MARKER = join('src', 'chemclaw', 'protocols', 'store.py');
const CHECKOUT = backendCheckout(STORE_MARKER);
const STORE = CHECKOUT === null ? null : join(CHECKOUT, STORE_MARKER);
const HAVE_SERVICE = STORE !== null;

if (!HAVE_SERVICE) {
  console.warn(
    `[protocol transitions] NOT CHECKED against the service: no ${STORE_MARKER} at ` +
      `${backendSearchPath(STORE_MARKER)}.`,
  );
}

/** The members of a Python `frozenset({...})` or list literal, as strings. */
const members = (literal: string): string[] =>
  [...literal.matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1] as string);

/**
 * `_LEGAL_MOVES` as the service declares it.
 *
 * Parsed rather than executed, which is the honest limit of this check and is stated here so
 * nobody reads more into a pass than it carries: it proves the *literal* in that module matches the
 * one here. A rule `require_movable` applies outside the table — the two document rules — is
 * asserted separately below, and anything the service enforces in a way this file cannot see is
 * caught by the 422 landing loudly in `ProtocolDocument`'s alert block instead.
 */
function serviceTable(source: string): Record<string, string[]> {
  const block = /_LEGAL_MOVES[^=]*=\s*\{([\s\S]*?)\n\}/.exec(source);
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
    // `CHEMCLAW3_REQUIRED=1` is how a lane says the sibling tree is there and a skip would be a
    // control it claims and does not have. The other cross-repository reader in this suite has
    // honoured it since the lane was wired; this one did not, so the Gate stage ran green with
    // this drift check off — measured with that stage's exact environment.
    expect(
      HAVE_SERVICE || !checkoutRequired(),
      `CHEMCLAW3_REQUIRED=1, and there is no ${STORE_MARKER} at ${backendSearchPath(STORE_MARKER)}`,
    ).toBe(true);
  });

  describe.skipIf(!HAVE_SERVICE)('against the service that enforces it', () => {
    const source = STORE === null ? '' : readFileSync(STORE, 'utf8');

    it('matches `_LEGAL_MOVES` in chemclaw/protocols/store.py, edge for edge', () => {
      const theirs = serviceTable(source);
      const ours = Object.fromEntries(
        Object.entries(LEGAL_STATUS_MOVES).map(([from, to]) => [from, [...to].sort()]),
      );
      expect(
        Object.fromEntries(Object.entries(theirs).map(([f, t]) => [f, [...t].sort()])),
      ).toEqual(ours);
    });

    it('matches `_NEEDS_A_PROTOCOL`, which outranks the table', () => {
      const declared = /_NEEDS_A_PROTOCOL[^=]*=\s*frozenset\(\{([^}]*)\}\)/.exec(source);
      expect(declared, '_NEEDS_A_PROTOCOL is no longer a frozenset literal').not.toBeNull();
      expect(members(declared?.[1] ?? '').sort()).toEqual([...STATUSES_NEEDING_A_PROTOCOL].sort());
    });

    it('still refuses `requested` on a protocol head, which is the rule with no table row', () => {
      // Written as an `if` in the service rather than as a set, so there is nothing to diff — what
      // this can check is that the branch still exists at all. If it is ever deleted there, the
      // filter here becomes a narrowing the service does not make.
      expect(source).toMatch(/status == "requested" and head_kind == "protocol"/);
    });
  });
});
