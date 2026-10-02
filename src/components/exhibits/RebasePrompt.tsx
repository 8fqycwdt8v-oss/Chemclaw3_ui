/**
 * "This artefact moved while you were editing it" — and what moved, before anything is saved.
 *
 * The shape `ProtocolEditor` uses for its own 409, with the one addition the artefact contract
 * makes possible: the service names the head it moved to, so the comparison can be drawn at once
 * — **your base against that head**, which is exactly what somebody else changed. The chemist then
 * applies their edit on top of it, or drops the edit and reads the new head. Neither is chosen for
 * them: a silent rebase would be the overwrite the 409 refused, one step later.
 *
 * `RevisionDiff` renders the service's `ExhibitDiff`, which is `DesignDiff`'s shape on purpose; one
 * diff component is one visual language for "what changed between two revisions", whichever
 * document it is.
 */

import { useAuth } from '../../auth/AuthContext.tsx';
import { useApiQuery } from '../../api/queryClient.ts';
import { exhibitDiffQuery } from '../../api/queries.ts';
import { RevisionDiff } from '../RevisionDiff.tsx';
import { Button } from '@/components/ui/button';
import { Loading } from '@/components/chem/Feedback';

export function RebasePrompt({
  sessionId,
  exhibitId,
  base,
  head,
  saving,
  onRetry,
  onDiscard,
}: {
  sessionId: string;
  exhibitId: string;
  base: number;
  head: number | null;
  saving: boolean;
  onRetry: () => void;
  onDiscard: () => void;
}): React.JSX.Element {
  const { auth } = useAuth();
  const { data: diff, error } = useApiQuery({
    ...exhibitDiffQuery(sessionId, exhibitId, base, head ?? 0, auth),
    enabled: head !== null && head > base,
  });

  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-lg border border-warn/40 bg-warn-soft p-3 text-sm"
    >
      <p className="text-warn-ink">
        {head === null
          ? `This artefact was revised after you opened revision ${base}. Your edit has not been saved.`
          : `This artefact was revised to revision ${head} after you opened revision ${base}. Your edit has not been saved — here is what changed in between.`}
      </p>
      {head !== null && head > base && !diff && !error && (
        <Loading size="xs">
          Comparing revision {base} with revision {head}…
        </Loading>
      )}
      {error && (
        <p className="text-xs text-ink-muted">The comparison could not be read: {error.message}</p>
      )}
      {diff && (
        <div className="rounded-md bg-surface-raised p-2">
          <RevisionDiff diff={diff} />
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onRetry} disabled={saving}>
          {head === null
            ? 'Save my edit on the latest revision'
            : `Save my edit on top of revision ${head}`}
        </Button>
        <Button variant="outline" size="sm" onClick={onDiscard} disabled={saving}>
          Discard my edit
        </Button>
      </div>
    </div>
  );
}
