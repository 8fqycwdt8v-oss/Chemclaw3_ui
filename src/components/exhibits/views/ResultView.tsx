/**
 * A tool result the chemist pinned as an artefact — drawn by the result registry, unchanged.
 *
 * No new renderer and no new code path: the payload is fetched through the same content-addressed
 * route and the same query key as the result block it was pinned from (`toolResultQuery`), and
 * drawn by the same `ResultBody` the full-result sheet uses, in its full (non-compact) form. A
 * pinned hazard screen therefore cannot say anything the block in the answer did not.
 *
 * What pinning adds is a home that outlives the scroll position: a stored result kept beside the
 * conversation, findable under "My artefacts", while the turn it came from scrolls away.
 */

import { useAuth } from '../../../auth/AuthContext.tsx';
import { useApiQuery } from '../../../api/queryClient.ts';
import { toolResultQuery } from '../../../api/queries.ts';
import type { ResultSpec } from '../../../../shared/exhibits.ts';
import { ResultBody } from '../../ResultSheet.tsx';
import { EmptyState, Loading } from '@/components/chem/Feedback';

export function ResultView({
  sessionId,
  spec,
}: {
  sessionId: string;
  spec: ResultSpec;
}): React.JSX.Element {
  const { auth, ready } = useAuth();
  const { data, error, isPending } = useApiQuery({
    ...toolResultQuery(sessionId, spec.result_ref, auth),
    enabled: ready,
  });

  if (error) {
    return (
      <EmptyState title="The pinned result could not be read" className="py-6">
        {error.message} Stored results are retained for a limited time, so an old pin may outlive
        the result it points at.
      </EmptyState>
    );
  }
  if (isPending || !data) return <Loading>Reading the pinned result…</Loading>;
  return (
    <div className="flex flex-col gap-2.5">
      <ResultBody result={data} onUsed={() => {}} />
      <p className="border-t border-border-subtle pt-2 text-2xs text-ink-subtle">
        {data.byte_size.toLocaleString()} bytes · correlation{' '}
        <span className="font-mono">{data.correlation_id || 'not recorded'}</span>
      </p>
    </div>
  );
}
