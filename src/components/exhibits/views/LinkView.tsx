/**
 * An artefact that *points at* something this system already keeps: a protocol, a note or a job.
 *
 * Each target is shown by the surface that already owns it, never by a fourth rendering of the
 * same record — the note by `NoteBody` (the citation panel's own body), the job by
 * `JobResultCard`/`JobFailureCard`, and the protocol by its header with a link into
 * `/protocols/{id}`, where `ProtocolDocument` holds the whole design with its sign-off controls.
 * The protocol is linked rather than embedded on purpose: that page is an editor with a 409
 * discipline and a status history, and a second copy squeezed into a side pane would be a second
 * place to approve a design from.
 *
 * A link artefact is never edited here. Changing what it points at is a new artefact, and
 * changing the thing pointed at is that thing's own page.
 */

import { useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../../../auth/AuthContext.tsx';
import { api } from '../../../api/client.ts';
import { keys, useApiQuery } from '../../../api/queryClient.ts';
import { protocolQuery } from '../../../api/queries.ts';
import type { LinkSpec } from '../../../../shared/exhibits.ts';
import type { JobSummary } from '../../../../shared/events.ts';
import { prefill } from '../../../state/composerEvents.ts';
import { JobFailureCard, JobResultCard } from '../../JobResultCard.tsx';
import { NoteBody } from '../../NoteSheet.tsx';
import { Badge } from '@/components/ui/badge';
import { EmptyState, Loading } from '@/components/chem/Feedback';

function ProtocolLink({ designId }: { designId: string }): React.JSX.Element {
  const { auth, ready } = useAuth();
  const { data, error, isPending } = useApiQuery({
    ...protocolQuery(designId, undefined, auth),
    enabled: ready,
  });
  return (
    <div className="flex flex-col gap-2">
      {isPending && !error && <Loading>Reading the protocol…</Loading>}
      {error && <p className="text-xs text-danger-ink">{error.message}</p>}
      {data && (
        <div className="flex flex-col gap-1">
          <p className="font-medium">{data.summary?.title || data.design.request.title}</p>
          <p className="flex flex-wrap items-center gap-1.5 text-2xs text-ink-muted">
            {data.summary && <Badge>{data.summary.status}</Badge>}
            <span>revision {data.revision}</span>
            <span className="font-mono">{designId}</span>
          </p>
        </div>
      )}
      <Link
        to={`/protocols/${encodeURIComponent(designId)}`}
        className="w-fit text-sm text-brand-ink underline-offset-2 hover:underline focus-ring"
      >
        Open the protocol document
      </Link>
    </div>
  );
}

function JobLink({ jobId }: { jobId: string }): React.JSX.Element {
  const { auth, ready } = useAuth();
  const { data, error, isPending } = useApiQuery({
    queryKey: keys.job(jobId),
    queryFn: () => api.getJob(jobId, auth),
    enabled: ready,
  });
  return (
    <div className="flex flex-col gap-2">
      {isPending && !error && <Loading>Reading the run…</Loading>}
      {error && <p className="text-xs text-danger-ink">{error.message}</p>}
      {data &&
        (data.status === 'failed' ? (
          <JobFailureCard jobId={jobId} reason={data.summary ?? ''} />
        ) : (
          <>
            <JobResultCard jobId={jobId} summary={data.result as JobSummary} />
            <p className="text-xs">
              <Badge tone={data.status === 'completed' ? 'ok' : 'neutral'}>{data.status}</Badge>{' '}
              {data.summary}
            </p>
          </>
        ))}
      <Link
        to={`/jobs/${encodeURIComponent(jobId)}`}
        className="w-fit text-sm text-brand-ink underline-offset-2 hover:underline focus-ring"
      >
        Open the run in the jobs list
      </Link>
    </div>
  );
}

export function LinkView({ spec }: { spec: LinkSpec }): React.JSX.Element {
  // Following a neighbour re-targets this view, as it re-targets the citation panel.
  const [noteId, setNoteId] = useState(spec.id);
  if (!spec.id) return <EmptyState title="This link names nothing" className="py-6" />;
  if (spec.target === 'protocol') return <ProtocolLink designId={spec.id} />;
  if (spec.target === 'job') return <JobLink jobId={spec.id} />;
  return (
    <div className="flex flex-col gap-4">
      <NoteBody
        noteId={noteId}
        enabled
        onFollow={setNoteId}
        onAsk={(id) => prefill(`Tell me what you know about ${id}.`)}
        onUsed={() => {}}
      />
    </div>
  );
}
