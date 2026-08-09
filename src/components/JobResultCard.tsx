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
import { Badge } from '@/components/ui/badge';

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
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {/* The id stays the sole content of its element: it is what a chemist copies into a
            ticket, and what the job tests match exactly. */}
        <span className="font-mono text-2xs text-ink-muted">{jobId}</span>
        {converged === true && <Badge tone="ok">converged</Badge>}
        {converged === false && <Badge tone="warn">not converged</Badge>}
      </div>

      {smiles && <Molecule smiles={smiles} className="my-1" />}

      {energy !== null && (
        <p className="mt-2 font-mono text-2xs tabular-nums text-ink-muted">{formatEnergy(energy)}</p>
      )}
    </>
  );
}
