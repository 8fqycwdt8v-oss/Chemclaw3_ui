/**
 * A refused tool call, said as the thing the chemist can do about it.
 *
 * The service distinguishes five gates from an ordinary fault (`agent/audit.refusal_reason`), and
 * the distinction is the point: **a refusal is the control working.** Rendering one in the same red
 * as an unreachable pod reports a correctly-governed turn as a broken one — the mistake the
 * backend's own live evaluation made before `tool_failed.reason` existed, and the mistake this UI
 * made for four of the five reasons for as long as the wire only carried `plan_gate`.
 *
 * Two things live here, and neither belongs in a component:
 *
 *  - **`isRefusal`** — the predicate `TracePanel` and `state/turnActivity` both ask. They used to
 *    ask it as `reason === 'plan_gate'`, separately, which is how a widened set would have reached
 *    the badge and not the counter (or the other way round) and left a turn reading "1 failure" and
 *    "needs approval" about the same row.
 *  - **`refusalCopy`** — the badge and the remedy. The remedy is the reason this is a table rather
 *    than a formatted enum: "the plan gate refused `submit_qm_job`" is a fact about the system, and
 *    "approve the plan above to let this step run" is the same fact said to the person who has to
 *    act on it. `AnswerBadges`' `capabilityLoss` is written under exactly this rule.
 *
 * Deliberately no entry for `null`. That is not a sixth kind of refusal, it is the absence of one —
 * an ordinary failure — and giving it a row here would invite a caller to render a remedy for a
 * database outage.
 */

import type { RefusalReason } from '../../shared/events.ts';

/** What a reader is told, and what they can do next. */
export interface RefusalCopy {
  /** The badge beside the tool name. Short, and never the raw wire value. */
  badge: string;
  /** One sentence: why nothing ran, and what would change it. */
  remedy: string;
}

/**
 * Whether this failure was a decision rather than a fault.
 *
 * Takes the whole `reason` — including `null`/`undefined` — so a caller never has to remember which
 * absent value the stream uses for "ordinary failure".
 */
export function isRefusal(reason: RefusalReason | null | undefined): reason is RefusalReason {
  return reason != null;
}

/**
 * The copy for one refusal.
 *
 * A `Record` over the union rather than a `switch` with a default: adding a sixth member to
 * `RefusalReason` fails the typecheck here, which is the one place that should have to change.
 * Every remedy names what the *reader* does, never which module raised — a chemist cannot act on
 * "UndeclaredWriteRefusal", and the tool's own name is already on the row beside this.
 */
const COPY: Record<RefusalReason, RefusalCopy> = {
  plan_gate: {
    badge: 'needs plan approval',
    remedy: 'Approve the plan to let this step run. Nothing was changed and no work was started.',
  },
  dry_run: {
    badge: 'skipped — dry run',
    remedy:
      'You asked for a dry run, so nothing that changes stored data or starts work was allowed ' +
      'to run. Turn Dry run off and ask again to let it through.',
  },
  authz: {
    badge: 'not permitted',
    remedy:
      'Your account does not hold the role this tool needs, so the call was refused rather than ' +
      'attempted. Whoever administers Chemclaw can grant it.',
  },
  undeclared_write: {
    badge: 'not available here',
    remedy:
      'This agent was not given this tool, so it could not run whatever it asked for. Another ' +
      'agent profile may carry it.',
  },
  repeat: {
    badge: 'stopped — repeated call',
    remedy:
      'The agent asked for the same thing again with the same arguments, and the guard stopped ' +
      'it rather than let the turn loop. The answer may be thinner as a result.',
  },
};

/** The badge and remedy for a refusal, or `null` for an ordinary failure. */
export function refusalCopy(reason: RefusalReason | null | undefined): RefusalCopy | null {
  return isRefusal(reason) ? COPY[reason] : null;
}
