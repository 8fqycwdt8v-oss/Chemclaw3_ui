/**
 * A refused tool call, said as what the chemist can do about it.
 *
 * The service distinguishes five refusal gates from ordinary faults (`agent/audit.refusal_reason`);
 * a refusal is the control working and must not render like a broken pod.
 * - **`isRefusal`**: the one predicate `TracePanel` and `state/turnActivity` share, so badge and
 *   counter agree.
 * - **`refusalCopy`**: the badge and the remedy, phrased as the reader's action (as
 *   `capabilityLoss` is). No entry for `null`: that is an ordinary failure, not a refusal.
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
 * Whether this failure was a decision rather than a fault. Accepts `null`/`undefined` so callers
 * need not know which absent value the stream uses.
 */
export function isRefusal(reason: RefusalReason | null | undefined): reason is RefusalReason {
  return reason != null;
}

/**
 * Copy per refusal. A `Record` over the union, so a new `RefusalReason` fails the typecheck here.
 * Remedies name what the reader does, never the raising module.
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
