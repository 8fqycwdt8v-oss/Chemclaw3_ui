/**
 * What a write from a view that is not an editor says while it saves — a detach, today.
 *
 * `TableView` and `DocumentView` grew these lines inline beside their editors. A structures panel
 * and a chart have no editor, and gained a write only with Detach (wave 3), so the same three
 * states — saving, refused, and moved underneath — are drawn here once for both, with the same
 * rebase prompt every other artefact edit gets on a 409.
 */

import { RebasePrompt } from './RebasePrompt.tsx';
import type { Revise } from './useRevise.ts';

export function ReviseNotices({
  sessionId,
  exhibitId,
  revise,
}: {
  sessionId: string;
  exhibitId: string;
  revise: Revise;
}): React.JSX.Element | null {
  const { state } = revise;
  if (state.status === 'stale') {
    return (
      <RebasePrompt
        sessionId={sessionId}
        exhibitId={exhibitId}
        base={state.base}
        head={state.head}
        saving={false}
        onRetry={() => void revise.retryOnHead()}
        onDiscard={revise.discard}
      />
    );
  }
  if (state.status === 'saving') {
    return (
      <p role="status" className="text-2xs text-ink-muted">
        Saving your edit as a new revision…
      </p>
    );
  }
  if (state.status === 'failed') {
    return (
      <p role="alert" className="text-xs text-danger-ink">
        {state.message}
      </p>
    );
  }
  return null;
}
