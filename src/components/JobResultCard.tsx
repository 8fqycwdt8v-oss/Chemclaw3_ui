/**
 * The rendering of one finished durable job's result.
 *
 * Shared by the two places a completion can arrive, which are genuinely different events despite
 * showing the same thing: inside a turn, as a trace row (`TracePanel`), and outside one, from the
 * push-back stream (`JobFeed`). A chemist should not have to learn two visual languages for "the
 * job finished" depending on whether they happened to be mid-conversation when it did.
 *
 * The summary is whatever the backend put in the push-back payload, so every field is probed
 * rather than assumed — a job kind with a different shape renders its id and nothing else instead
 * of throwing.
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
 * The artefact a finished job wrote, when its summary names one (G1).
 *
 * `request_development_report` records a `report` note and — since artefacts wave 2 — a `document`
 * artefact in the session that asked for it, and says which in `summary.exhibit_id`. Read through
 * `EXHIBIT_ID_RE` rather than trusted: the summary is a bare `dict[str, object]` upstream, and a
 * button that opened the pane on a string the service never minted would open it on nothing.
 */
export function reportExhibitOf(summary: JobSummary | undefined): string | null {
  const id = summary?.exhibit_id;
  return typeof id === 'string' && EXHIBIT_ID_RE.test(id) ? id : null;
}

/**
 * **Open report**: the report artefact, in front, in the pane — from wherever the card is.
 *
 * From the push-back feed that may be another conversation, so it is gone to first (`navigate`),
 * and the pane is told which artefact to show *for that session* (`show` is keyed by session, so
 * the focus waits for the conversation to mount rather than landing on this one). The list is
 * refetched as well: the `exhibit` push that announces the report is best effort, and this click is
 * the moment the reader needs the list to contain it.
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
 * The other ending, and the one this UI used to have no rendering for at all.
 *
 * Same two arrival points as `JobResultCard`, same argument for sharing one component. The wording
 * carries a distinction the wire cannot: `reason` is documented as possibly empty, and an empty
 * reason must still read as a failure rather than as a blank card, so the fallback sentence says
 * what is known ("it failed") and does not guess at what is not ("why").
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
