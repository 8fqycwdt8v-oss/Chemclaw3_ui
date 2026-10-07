/**
 * One finished durable job's result, shared by the trace row (`TracePanel`, inside a turn) and the
 * push-back feed (`JobFeed`, outside one), so both look the same. Summary fields are probed, not
 * assumed; an unknown shape renders just the id.
 */

import { CircleX, FileText } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { JobSummary } from '../../shared/events.ts';
import { EXHIBIT_ID_RE } from '../../shared/exhibitConstants.ts';
import { keys, queryClient } from '../api/queryClient.ts';
import { formatEnergy } from '../lib/format.ts';
import { useChatStore } from '../state/chatStore.ts';
import { useExhibitPane } from '../state/exhibitPane.ts';
import { Molecule } from './Molecule.tsx';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/**
 * The artefact a finished job wrote, when `summary.exhibit_id` names one (e.g.
 * `request_development_report`'s document). Checked against `EXHIBIT_ID_RE` because the summary is
 * an untyped dict upstream.
 */
export function reportExhibitOf(summary: JobSummary | undefined): string | null {
  const id = summary?.exhibit_id;
  return typeof id === 'string' && EXHIBIT_ID_RE.test(id) ? id : null;
}

/**
 * **Open report**: navigate to the job's conversation if needed, focus the report there (`show` is
 * keyed by session, so it waits for the mount), and refetch the list, since the announcing
 * `exhibit` push is best effort.
 */
function OpenReport({
  exhibitId,
  sessionId,
  conversationId,
}: {
  exhibitId: string;
  sessionId: string;
  conversationId: string | null;
}): React.JSX.Element {
  const navigate = useNavigate();
  const activeId = useChatStore((s) => s.activeId);
  return (
    <Button
      variant="outline"
      size="xs"
      className="mt-2"
      onClick={() => {
        void queryClient.invalidateQueries({ queryKey: keys.exhibits(sessionId) });
        useExhibitPane.getState().show(sessionId, exhibitId);
        if (conversationId && conversationId !== activeId) void navigate(`/c/${conversationId}`);
      }}
    >
      <FileText aria-hidden className="size-3.5" />
      Open report
    </Button>
  );
}

export function JobResultCard({
  jobId,
  summary,
  sessionId = null,
  conversationId = null,
}: {
  jobId: string;
  summary: JobSummary | undefined;
  /** The session the job belongs to — what "Open report" opens the artefact in. */
  sessionId?: string | null;
  /** The conversation holding that session, when the card may be shown outside it. */
  conversationId?: string | null;
}): React.JSX.Element {
  const fields = summary ?? {};
  const report = reportExhibitOf(summary);
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
        <p className="mt-2 font-mono text-2xs tabular-nums text-ink-muted">
          {formatEnergy(energy)}
        </p>
      )}

      {report && sessionId && (
        <OpenReport exhibitId={report} sessionId={sessionId} conversationId={conversationId} />
      )}
    </>
  );
}

/**
 * A failed job, shared like `JobResultCard`. `reason` may be empty, so the fallback says it failed
 * without guessing why.
 */
export function JobFailureCard({
  jobId,
  reason,
}: {
  jobId: string;
  reason: string;
}): React.JSX.Element {
  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <CircleX aria-hidden className="size-3.5 shrink-0 text-danger-ink" />
        <span className="font-mono text-2xs text-ink-muted">{jobId}</span>
        <Badge tone="danger">failed</Badge>
      </div>
      <p className="text-2xs text-danger-ink">
        {reason.trim() ||
          'The service reported no reason. The job did not produce a result — it is not still running.'}
      </p>
    </>
  );
}
