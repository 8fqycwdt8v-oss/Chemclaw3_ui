/**
 * The rendering of one finished durable job's result.
 *
 * Shared by the two places a completion can arrive, which are genuinely different events despite
 * showing the same thing: inside a turn, as a trace row (`TracePanel`), and outside one, from the
 * push-back stream (`JobFeed`). A chemist should not have to learn two visual languages for "the
 * DFT job finished" depending on whether they happened to be mid-conversation when it did.
 *
 * The summary is whatever the backend put in the push-back payload, so every field is probed
 * rather than assumed — a job kind with a different shape renders its id and nothing else instead
 * of throwing.
 */

import type { JobSummary } from '../../shared/events.ts';
import { formatEnergy } from '../lib/format.ts';
import { Molecule } from './Molecule.tsx';

export function JobResultCard({
  jobId,
  summary,
}: {
  jobId: string;
  summary: JobSummary | undefined;
}): React.JSX.Element {
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
          <span className="rounded bg-ok-soft px-1.5 py-0.5 text-xs text-ok-ink">converged</span>
        )}
        {converged === false && (
          <span className="rounded bg-warn-soft px-1.5 py-0.5 text-xs text-warn-ink">
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
