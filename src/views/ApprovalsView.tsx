/**
 * Open approval holds, outside the conversation that raised them.
 *
 * `api.listApprovals` and `api.decideApproval` have existed in the client for a while and no view
 * has ever called them. That is the same dead end the backend route was added to close: a hold's
 * id was only ever returned into a turn that then ended, so a hold nobody could find could only
 * time out — silently dropping the knowledge write it was holding. A conversation that has been
 * scrolled past is not much better than one that never rendered it.
 *
 * Scoped to the caller by the service, and correctly: a hold authorizes a knowledge write on
 * behalf of the chemist whose turn raised it, so it is theirs to answer. Nothing here filters —
 * what arrives is already what this person may decide.
 */

import { useState } from 'react';
import { api, type PendingApproval } from '../api/client.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { Button, Callout, Page } from './ui.tsx';
import { errorText, useResource } from './useResource.ts';

/** `PendingApproval` is typed with an index signature because the wire shape has grown before.
 *  Read the two fields that make a hold answerable, and probe rather than assume. */
const text = (approval: PendingApproval, key: string): string => {
  const value = approval[key];
  return typeof value === 'string' ? value : '';
};

export function ApprovalsView(): React.JSX.Element {
  const holds = useResource<PendingApproval[]>((getToken) => api.listApprovals(getToken), []);

  return (
    <Page
      title="Approvals"
      subtitle="Durable holds waiting on your Yes or No. Answering one releases the turn that is waiting on it."
      actions={
        <Button onClick={holds.reload} disabled={holds.loading}>
          {holds.loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      }
    >
      {holds.error !== undefined && (
        <Callout tone="danger" title="Open holds could not be read.">
          {errorText(holds.error)} This is not the same as having none.
        </Callout>
      )}

      {holds.data?.length === 0 && holds.error === undefined && (
        <Callout tone="neutral">Nothing is waiting on you.</Callout>
      )}

      <ul className="space-y-2">
        {(holds.data ?? []).map((approval) => {
          const id = approval.approval_id ?? text(approval, 'approval_id');
          return (
            <li key={id}>
              <HoldCard
                approvalId={id}
                question={text(approval, 'question')}
                requestedBy={text(approval, 'requested_by')}
                onDecided={holds.reload}
              />
            </li>
          );
        })}
      </ul>
    </Page>
  );
}

function HoldCard({
  approvalId,
  question,
  requestedBy,
  onDecided,
}: {
  approvalId: string;
  question: string;
  requestedBy: string;
  onDecided: () => void;
}): React.JSX.Element {
  const { auth } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (approved: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.decideApproval(approvalId, approved, () => auth.getAccessToken());
      onDecided();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-accent/40 bg-accent-soft p-3">
      <p className="text-sm font-medium text-ink">
        {question || 'This hold did not state its question.'}
      </p>
      <p className="mt-1 font-mono text-xs break-all text-ink-muted">
        {approvalId}
        {requestedBy && ` · raised by ${requestedBy}`}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button tone="ok" onClick={() => void decide(true)} disabled={busy || !approvalId}>
          Approve
        </Button>
        <Button tone="danger" onClick={() => void decide(false)} disabled={busy || !approvalId}>
          Reject
        </Button>
        {busy && <span className="text-sm text-ink-muted">Recording…</span>}
      </div>
      {error !== null && (
        <div className="mt-2">
          <Callout tone="danger" title="The decision was not delivered.">
            {error}
          </Callout>
        </div>
      )}
    </div>
  );
}
