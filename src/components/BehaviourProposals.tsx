/**
 * Skills the agent has proposed, decided in place by the person they would act on (the service
 * returns the whole document, so nothing needs reading elsewhere).
 *
 * The empty state distinguishes three things: no proposal store (**503**), a failed call, and a
 * genuinely empty queue; `api.listProposals` does not fold errors into `[]`. Accepting writes the
 * skill immediately for this person only, and the copy says so. Decisions are final; recovery after
 * a decline is via the skills screen, which the confirm names.
 */

import { useState } from 'react';
import { Lightbulb } from 'lucide-react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext.tsx';
import { keys, useApiQuery } from '../api/queryClient.ts';
import { api, type BehaviourProposal } from '../api/client.ts';
import { ApiError } from '../api/errors.ts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/chem/ConfirmDialog';
import { EmptyState, Loading } from '@/components/chem/Feedback';

/**
 * The frontmatter `description:`, read off the body so there is one source. A one-line regex, not a
 * YAML parser: this is only a preview beside the body.
 */
function described(body: string): string {
  const frontmatter = body.split('---')[1] ?? '';
  const match = /^description:\s*(.+)$/m.exec(frontmatter);
  return match?.[1]?.trim() ?? '';
}

/** One proposal: what it is, why, and the document itself. */
function Proposal({
  proposal,
  onDecided,
}: {
  proposal: BehaviourProposal;
  onDecided: () => void;
}): React.JSX.Element {
  const { auth } = useAuth();
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const [failed, setFailed] = useState<string>('');
  const description = described(proposal.content);
  // A `profile` proposal is a record only: accepting it writes nothing (profiles change via commits
  // to `data/profiles/`), so skill copy does not apply.
  const isSkill = proposal.kind === 'skill';

  async function decide(accepted: boolean): Promise<void> {
    setBusy(accepted ? 'accept' : 'decline');
    setFailed('');
    try {
      await api.decideProposal(auth, proposal.kind, proposal.name, proposal.content_hash, accepted);
      onDecided();
    } catch (err) {
      // Show the service's sentence: a 409 has several causes (already decided, superseded, name
      // taken by a shipped skill, personal-tier cap) and only the service knows which. A 503 means
      // the deployment cannot keep the skill.
      setFailed(
        err instanceof ApiError
          ? err.status === 409
            ? err.message
            : err.status === 503
              ? 'This deployment cannot keep personal skills, so accepting would record a decision that changes nothing.'
              : err.message
          : 'The decision did not go through.',
      );
      setBusy(null);
    }
  }

  return (
    <li className="rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium">{proposal.name}</h3>
        <Badge>{proposal.kind}</Badge>
      </div>
      {description && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
      <p className="mt-2 text-sm">{proposal.rationale}</p>

      <details className="mt-3">
        <summary className="cursor-pointer text-sm text-ink-muted">
          Read the whole {isSkill ? 'skill' : 'profile'} ({proposal.content.length.toLocaleString()}{' '}
          characters)
        </summary>
        {/* Preformatted, not rendered: the frontmatter is part of what is approved. */}
        <pre className="mt-2 max-h-96 overflow-auto rounded bg-surface-sunken p-3 text-xs whitespace-pre-wrap">
          {proposal.content}
        </pre>
      </details>

      {proposal.session_id && (
        <p className="mt-2 text-xs text-ink-muted">
          Proposed in{' '}
          <Link className="underline" to={`/open/${proposal.session_id}`}>
            the conversation it came out of
          </Link>
          .
        </p>
      )}

      {failed && <p className="mt-2 text-sm text-danger">{failed}</p>}

      <div className="mt-3 flex gap-2">
        <Button size="sm" disabled={busy !== null} onClick={() => void decide(true)}>
          {busy === 'accept'
            ? isSkill
              ? 'Keeping…'
              : 'Recording…'
            : isSkill
              ? 'Keep this skill'
              : 'Record that you want it'}
        </Button>
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="outline" disabled={busy !== null}>
              {busy === 'decline' ? 'Declining…' : 'Decline'}
            </Button>
          }
          title={`Decline ${proposal.name}?`}
          description={
            isSkill
              ? 'A decision is final: the same text cannot be proposed again. If you want it later, write it yourself on the skills screen.'
              : 'A decision is final: the same text cannot be proposed again.'
          }
          confirmLabel="Decline"
          variant="destructive"
          onConfirm={() => void decide(false)}
        />
      </div>
      <p className="mt-2 text-xs text-ink-muted">
        {isSkill
          ? "Keeping it makes it act on your turns from the next one, and on nobody else's."
          : 'Accepting only records that you want it. A profile takes effect through a reviewed commit to data/profiles/, so nothing changes on your turns until somebody makes that change.'}
      </p>
    </li>
  );
}

/** The section. */
export function BehaviourProposals(): React.JSX.Element {
  // Gated on `ready` so a cold load does not fail `token_unavailable` and stay failed. `isPending`,
  // not `isLoading`, because a disabled query is pending without fetching.
  const { auth, ready } = useAuth();
  const { data, error, isPending, refetch } = useApiQuery({
    queryKey: keys.proposals,
    queryFn: () => api.listProposals(auth),
    enabled: ready,
  });

  if (isPending) return <Loading>Loading what the agent has proposed…</Loading>;

  if (error) {
    // Keep the three "nothing here" states apart; 503 names the setting that changes it, for the
    // operator.
    const unavailable = error instanceof ApiError && error.status === 503;
    return (
      <EmptyState
        icon={<Lightbulb className="size-5" />}
        title={unavailable ? 'This deployment keeps no proposals' : 'Could not load proposals'}
      >
        {unavailable
          ? 'The agent cannot suggest a skill here, and nothing can accept one. It needs the durable memory store (CHEMCLAW_AGENT_MEMORY_ENABLED with a Postgres session store).'
          : error instanceof Error
            ? error.message
            : 'The service did not answer.'}
      </EmptyState>
    );
  }

  const proposals = data ?? [];
  if (proposals.length === 0) {
    return (
      <EmptyState icon={<Lightbulb className="size-5" />} title="Nothing proposed">
        When a turn works out a procedure worth keeping, it can propose it here for you to accept.
        Nothing it proposes acts on anything until you do.
      </EmptyState>
    );
  }

  return (
    <ul className="space-y-3">
      {proposals.map((proposal) => (
        <Proposal
          key={`${proposal.kind}:${proposal.name}:${proposal.content_hash}`}
          proposal={proposal}
          onDecided={() => void refetch()}
        />
      ))}
    </ul>
  );
}
