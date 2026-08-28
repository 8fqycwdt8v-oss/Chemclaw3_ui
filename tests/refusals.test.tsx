/**
 * A refused tool call is the control working, and the trace has to say which control.
 *
 * The service classifies five gates (`agent/audit.refusal_reason`); the wire carried one for a
 * release, and this UI rendered the other four in the same red as an unreachable pod. So a chemist
 * who switched **Dry run** on — a control they operated themselves, one line above the composer —
 * read their own choice back as a broken tool, and a role denial looked like an outage rather than
 * like something an administrator can grant.
 *
 * What is pinned here is the property rather than the wording: every member of the wire's closed
 * set reads as a refusal, in the badge *and* in the counter that summarises the turn, and an
 * ordinary fault still reads as a failure. The counter matters as much as the badge — they used to
 * ask the question separately, which is how a turn could report "1 failure" in its summary and
 * "needs plan approval" on the row it was counting.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TracePanel } from '../src/components/TracePanel.tsx';
import { summarizeTurn } from '../src/state/turnActivity.ts';
import { isRefusal, refusalCopy } from '../src/lib/refusals.ts';
import { REFUSAL_REASONS, normalizeEvent } from '../shared/events.ts';
import type { RefusalReason } from '../shared/events.ts';
import type { TraceEntry } from '../src/state/types.ts';

const failure = (reason: RefusalReason | null): TraceEntry => ({
  id: 't1',
  at: 0,
  kind: 'tool_failed',
  toolFailure: { tool: 'submit_qm_job', message: 'the gate said no', reason },
});

describe('the refusal vocabulary', () => {
  it('mirrors every reason the service can send', () => {
    // Transcribed against the backend's `core/turn_signals.RefusalReason`, which is the single
    // definition its classification table and its wire model both import. A member added there and
    // not here is dropped in transit by `normalizeEvent`, which rebuilds each event field by field.
    expect([...REFUSAL_REASONS].sort()).toEqual(
      ['authz', 'dry_run', 'plan_gate', 'repeat', 'undeclared_write'].sort(),
    );
  });

  it('gives every reason a badge and a remedy, and gives an ordinary failure neither', () => {
    for (const reason of REFUSAL_REASONS) {
      const copy = refusalCopy(reason);
      expect(copy, reason).toBeTruthy();
      // The remedy is the reason this is a table: it must say what the READER does, so it cannot
      // just be the reason with underscores removed.
      expect(copy!.remedy.length, reason).toBeGreaterThan(20);
      expect(copy!.badge, reason).not.toContain('_');
    }
    expect(refusalCopy(null)).toBeNull();
    expect(isRefusal(null)).toBe(false);
    expect(isRefusal(undefined)).toBe(false);
  });

  it('normalises a reason this build does not know to an ordinary failure', () => {
    // Never to a refusal it cannot render: an unknown value must read as a plain fault rather than
    // reaching a component that would look it up and find nothing.
    const event = normalizeEvent({ type: 'tool_failed', tool: 't', message: 'm', reason: 'nope' });
    expect(event && 'reason' in event ? event.reason : undefined).toBeNull();
  });
});

describe('a refusal in the trace', () => {
  // The loop below renders once per reason; without this the last one stays mounted and the next
  // test finds two panels.
  beforeEach(cleanup);

  /** The panel is collapsed until somebody comes to check the work, which is the point of it. */
  const expand = (): void => {
    fireEvent.click(screen.getByRole('button', { name: /step/ }));
  };

  it('reads as a refusal for every reason, not only the plan gate', () => {
    for (const reason of REFUSAL_REASONS) {
      cleanup();
      render(<TracePanel trace={[failure(reason)]} />);
      expand();
      const copy = refusalCopy(reason)!;
      // The badge is the reason's own, and the remedy is on the row beside it.
      expect(screen.getByText(copy.badge), reason).toBeTruthy();
      expect(screen.getByText(copy.remedy), reason).toBeTruthy();
      // And it is NOT the failure treatment.
      expect(screen.queryByText('failed'), reason).toBeNull();
    }
  });

  it('still reads an ordinary fault as a failure', () => {
    render(<TracePanel trace={[failure(null)]} />);
    expand();
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.getByText('the gate said no')).toBeTruthy();
  });

  it('counts every refusal as held rather than as a problem', () => {
    // The half that used to disagree with the badge. `summarizeTurn` asked
    // `reason === 'plan_gate'` on its own, so a widened set would have reached the row and not the
    // summary — one turn, two answers about the same event.
    for (const reason of REFUSAL_REASONS) {
      const summary = summarizeTurn([failure(reason)]);
      expect([reason, summary.held, summary.problems]).toEqual([reason, 1, 0]);
    }
    const fault = summarizeTurn([failure(null)]);
    expect([fault.held, fault.problems]).toEqual([0, 1]);
  });
});
