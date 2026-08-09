/**
 * The rendering of one finished durable job — either ending.
 *
 * Shared by the two places an outcome can arrive, which are genuinely different events despite
 * showing the same thing: inside a turn, as a trace row (`TracePanel`), and outside one, from the
 * push-back stream (`JobFeed`). A chemist should not have to learn two visual languages for "the
 * DFT job finished" depending on whether they happened to be mid-conversation when it did.
 *
 * The summary is whatever the backend put in the push-back payload, so every field is probed
 * rather than assumed — a job kind with a different shape renders its id and nothing else instead
 * of throwing.
 *
 * A failure renders here rather than in its own component for the same reason both callers share
 * this one: it is the same object at the same point in its life, and the thing a chemist most
 * needs to see is which of the two it was. Splitting them would put the two states in two visual
 * languages again, one file down.
 */

import type { JobSummary } from '../../shared/events.ts';
import { formatEnergy } from '../lib/format.ts';
import { Molecule } from './Molecule.tsx';

export function JobResultCard({
  jobId,
  summary,
  reason,
}: {
  jobId: string;
  summary?: JobSummary | undefined;
  /**
   * Set exactly when the job failed. Its presence is the discriminator — `job_failed` carries no
   * summary and `job_completed` carries no reason, so there is no third state to render and no
   * flag to keep in step with the payload.
   *
   * May be an empty string: the backend defaults it, and a failure with no stated reason is still
   * a failure the chemist must be told about. That case renders the heading without a body rather
   * than falling through to "completed".
   */
  reason?: string | undefined;
}): React.JSX.Element {
  if (reason !== undefined) {
    return (
      <>
        <div className="mb-2 flex items-center gap-2">
          <span className="font-mono text-xs text-ink-muted">{jobId}</span>
          <span className="rounded bg-danger-soft px-1.5 py-0.5 text-xs text-danger">failed</span>
        </div>
        {reason ? (
          <p className="text-xs text-danger">{reason}</p>
        ) : (
          <p className="text-xs text-ink-muted">The service did not say why.</p>
        )}
      </>
    );
  }

  const fields = summary ?? {};
  const smiles = typeof fields.molecule_smiles === 'string' ? fields.molecule_smiles : null;
  const energy =
    typeof fields.total_energy_hartree === 'number' ? fields.total_energy_hartree : null;
  const converged = fields.converged;

  return (
    <>
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-xs text-ink-muted">{jobId}</span>
        {converged === true && (
          <span className="rounded bg-ok-soft px-1.5 py-0.5 text-xs text-ok">converged</span>
        )}
        {converged === false && (
          <span className="rounded bg-warn-soft px-1.5 py-0.5 text-xs text-warn">
            not converged
          </span>
        )}
      </div>
      {smiles && <Molecule smiles={smiles} width={280} height={190} />}
      {energy !== null && (
        <p className="mt-2 font-mono text-xs text-ink-muted">{formatEnergy(energy)}</p>
      )}
    </>
  );
}
