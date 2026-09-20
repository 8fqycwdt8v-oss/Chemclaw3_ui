/**
 * Skills the agent has proposed, waiting on the person they would act on.
 *
 * **This is the third inbox this page has carried and the first that can decide in place**, so the
 * reason is worth stating against the two that could not. A *plan* is approved on the strength of
 * the reasoning that produced it, which lives in a conversation, so `ReviewQueue.tsx` links back
 * rather than answering here. A *proposal* under the deleted PR-gate was machine-written knowledge,
 * and that gate is gone. This is neither: a skill **is** the document, the service returns it whole
 * for exactly that reason (`api/routes/proposals.ProposalOut`), and there is nothing a reader would
 * go elsewhere to learn. Deciding here is informed, which is the bar the plan section set.
 *
 * **The empty state is the part this file exists to get right.** `ReviewQueue.tsx` has had to
 * delete two inboxes for decisions that could not occur, and both times the failure was identical
 * and quiet — a list route 404s, the client folds it into `[]`, and the section renders a confident
 * permanently-empty queue that reads as "you are up to date". So `api.listProposals` deliberately
 * does not degrade, and this screen distinguishes three states that all look like "nothing here":
 * the deployment keeps no proposals at all (**503**), the call failed, and the genuine empty queue.
 *
 * **Accepting writes the skill inside the decision**, so a person who accepts has changed what
 * their own turns do, immediately and for nobody else. The copy says so rather than saying
 * "accepted", because the one thing a reader must not have to guess is whether anything happened.
 *
 * **A decision is final and the copy does not pretend otherwise.** The service refuses a second
 * decision on the same document and says so; re-proposing the same bytes cannot reopen it. Declining
 * something you later want is recoverable, but through the skills screen rather than through here,
 * which is why the confirm names that path instead of implying an undo this queue does not have.
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
 * The frontmatter `description:` a skill declares, or nothing.
 *
 * Read off the body rather than asked for as a field, because the body is what is being decided and
 * a second source for one string is a second thing that can disagree with it. Deliberately naive —
 * a one-line regex over the block, not a YAML parser: this is a *preview* beside the document, so
 * the cost of missing an exotic spelling is that the reader sees the body, which they were going to
 * read anyway.
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

  async function decide(accepted: boolean): Promise<void> {
    setBusy(accepted ? 'accept' : 'decline');
    setFailed('');
    try {
      await api.decideProposal(auth, proposal.kind, proposal.name, proposal.content_hash, accepted);
      onDecided();
    } catch (err) {
      // Named rather than swallowed, and the two that matter are distinguishable: a 409 means
      // somebody already decided this exact document or a newer version replaced it, and a 503
      // means the deployment cannot keep the skill this decision would write.
      setFailed(
        err instanceof ApiError
          ? err.status === 409
            ? 'This one has already been decided, or a newer version replaced it. Reload to see what stands.'
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
          Read the whole skill ({proposal.content.length.toLocaleString()} characters)
        </summary>
        {/* Preformatted rather than rendered: a `SKILL.md` is a document whose frontmatter is part
            of what is being approved, and rendering it would hide the half that decides where it
            applies. */}
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
          {busy === 'accept' ? 'Keeping…' : 'Keep this skill'}
        </Button>
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="outline" disabled={busy !== null}>
              {busy === 'decline' ? 'Declining…' : 'Decline'}
            </Button>
          }
          title={`Decline ${proposal.name}?`}
          description="A decision is final: the same text cannot be proposed again. If you want it later, write it yourself on the skills screen."
          confirmLabel="Decline"
          variant="destructive"
          onConfirm={() => void decide(false)}
        />
      </div>
      <p className="mt-2 text-xs text-ink-muted">
        Keeping it makes it act on your turns from the next one, and on nobody else's.
      </p>
    </li>
  );
}

/** The section. */
export function BehaviourProposals(): React.JSX.Element {
  const { auth } = useAuth();
  const { data, error, isLoading, refetch } = useApiQuery({
    queryKey: keys.proposals,
    queryFn: () => api.listProposals(auth),
  });

  if (isLoading) return <Loading>Loading what the agent has proposed…</Loading>;

  if (error) {
    // The three readings of "nothing here", kept apart. 503 is a *configuration* fact and says so
    // with the setting that changes it, because an operator reading this over somebody's shoulder
    // is the person who can fix it.
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
