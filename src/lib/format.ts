/** Small display helpers for the chemistry payloads the backend returns. */

import type { ErrorCode } from '../../shared/events.ts';

/** Hartree to kcal/mol. The backend reports QM energies in hartree; chemists mostly think in
 *  kcal/mol, so we show both rather than making anyone convert in their head. */
export const HARTREE_TO_KCAL = 627.5094740631;

export function formatEnergy(hartree: number): string {
  const kcal = hartree * HARTREE_TO_KCAL;
  return `${hartree.toFixed(6)} Eh (${kcal.toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })} kcal/mol)`;
}

export function relativeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Human label for a tool name, e.g. `gather_evidence` -> `Gather evidence`. */
export function toolLabel(tool: string): string {
  const words = tool.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What to do next about a failed turn.
 *
 * The service's `ErrorCode` set is closed and each member is *a different thing for the user to
 * do* — that is the whole reason it exists and is this short. None of it was rendered: every
 * failure showed one message and no next step, so "try again" was as likely to be wrong as right.
 *
 * `retryable` is read alongside the code rather than instead of it, because one code carries both
 * answers. `budget_exhausted` is sent retryable when the front door shed a turn at capacity and
 * not retryable when the session has genuinely spent its allowance, and telling someone to wait
 * for a budget that does not replenish wastes their afternoon.
 *
 * Returns null for an unclassified failure — a dropped socket never reached the service, so there
 * is no code and nothing honest to suggest beyond the message itself.
 */
export function errorNextStep(code: ErrorCode | undefined, retryable: boolean | undefined): string | null {
  switch (code) {
    case 'turn_timeout':
      return 'The turn hit the service’s wall-clock limit. Ask again in smaller pieces — one calculation or one lookup at a time.';
    case 'budget_exhausted':
      return retryable
        ? 'The service was at capacity and shed this turn. Nothing is wrong with the question; wait a moment and ask it again.'
        : 'This session has spent its token budget. It does not replenish on a retry — start a new conversation, or ask an operator to raise the limit.';
    case 'loop_cap_reached':
      return 'The turn hit its iteration limit with work still open, so anything above is partial. The same question drives the same loop into the same cap: ask a narrower one.';
    case 'empty_answer':
      // Nothing broke. The turn ran to completion and wrote no prose, and offering "an internal
      // error occurred" for it sends the reader to an operator for a question they can simply
      // ask better. The backend gave this its own code for exactly that reason.
      return 'The turn ran to the end and wrote nothing. Nothing broke — ask something narrower or more specific.';
    case 'bad_tool_arguments':
      return 'A tool rejected its input — a malformed structure, an unbalanced equation, an unsupported solvent. Fix the input and ask again; retrying it unchanged cannot work.';
    case 'storage_unavailable':
      return 'The service could not reach its store. Nothing was lost; this usually clears on its own, so try again shortly.';
    case 'llm_timeout':
      return 'The model did not answer in time. Asking again unchanged is worth one attempt.';
    case 'internal':
      return 'The service did not classify this failure, which means nobody has seen this shape yet. Quote the correlation id below if it happens again.';
    default:
      return null;
  }
}
