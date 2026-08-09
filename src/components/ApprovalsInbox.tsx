/**
 * The review queue: every approval hold waiting on this chemist, answerable from anywhere.
 *
 * This closes the last stretch of a path that was broken end to end. A hold was started, its id
 * was returned once into a turn, and that turn ended — so the only way to answer it was to still
 * be looking at the message that raised it. The backend built `GET /approvals` for this exact
 * reason; the inbox is where a hold raised in yesterday's conversation becomes clickable again.
 *
 * In the header rather than the sidebar, and always present rather than only when non-empty. In
 * the sidebar it would sit behind a drawer on every phone, which for something that expires is the
 * wrong place; and a control that appears only when there is bad news is a control nobody learns
 * the location of. The count badge carries the urgency instead.
 */

import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api } from '../api/client.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { useApprovals } from '../hooks/useApprovals.ts';
import { DecisionControls } from './Prompts.tsx';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** One hold, with the controls that answer it. */
function Hold({
  approvalId,
  question,
  onDecided,
}: {
  approvalId: string;
  question: string;
  onDecided: () => void;
}): React.JSX.Element {
  const { auth } = useAuth();
  const [state, setState] = useState<'idle' | 'sending' | 'approved' | 'rejected' | 'failed'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);

  const decide = async (approved: boolean): Promise<void> => {
    setState('sending');
    setError(null);
    try {
      await api.decideApproval(approvalId, approved, () => auth.getAccessToken());
      setState(approved ? 'approved' : 'rejected');
      // This marks the hold answered; it does not remove the row. `DecisionControls` swaps itself
      // for "You approved this request", and that sentence is the only confirmation the click
      // gets. A row that vanished the instant it was answered would take the confirmation with it,
      // on the most consequential control in the product.
      onDecided();
    } catch (err) {
      setState('failed');
      setError(err instanceof Error ? err.message : 'Could not deliver the decision.');
    }
  };

  return (
    <li className="rounded-lg border border-warn/40 bg-warn-soft p-3.5">
      <p className="mb-2.5 flex items-start gap-2 text-sm text-warn-ink">
        <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
        <span>{question}</span>
      </p>
      <DecisionControls
        state={state}
        error={error}
        labels={['Approve', 'Reject']}
        onDecide={(approved) => void decide(approved)}
      />
      <p className="mt-2 font-mono text-2xs text-ink-subtle">{approvalId}</p>
    </li>
  );
}

export function ApprovalsInbox(): React.JSX.Element {
  const { holds, status, refresh, resolve } = useApprovals();
  const [open, setOpen] = useState(false);
  const [decided, setDecided] = useState<Set<string>>(new Set());

  const waiting = holds.filter((hold) => !decided.has(hold.approval_id)).length;

  // Named for what is waiting, not for the panel. A screen-reader user tabbing the header needs to
  // hear the count without opening anything, and "Approvals" alone would make the badge — which is
  // where the whole signal lives — decorative.
  const label =
    status === 'unavailable'
      ? 'Approvals — could not be loaded'
      : waiting === 0
        ? 'Approvals — nothing waiting'
        : `Approvals — ${waiting} waiting`;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          // A hold answered inline in the transcript is already gone server-side; re-reading on
          // open is what keeps this panel from showing it as still waiting.
          refresh();
          return;
        }
        // Close is when the answered rows are retired — they were kept open only to show what was
        // decided. Doing it here rather than at decision time is what lets the confirmation be
        // read; doing it at all is what stops them coming back on the next open.
        for (const approvalId of decided) resolve(approvalId);
        setDecided(new Set());
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={label} className="relative">
              <ShieldCheck />
              {waiting > 0 && (
                <span
                  // aria-hidden: the count is already in the button's accessible name, and a
                  // screen reader reading the digit twice is worse than not styling it at all.
                  aria-hidden
                  className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-warn text-2xs font-semibold text-warn-fg"
                >
                  {waiting > 9 ? '9+' : waiting}
                </span>
              )}
            </Button>
          </SheetTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>

      <SheetContent side="right" title="Approvals" className="w-full sm:max-w-md">
        <div className="flex h-full flex-col gap-3 overflow-y-auto p-4 pt-12">
          <div>
            <h2 className="text-sm font-semibold">Approvals</h2>
            <p className="mt-1 text-xs text-ink-muted">
              Holds raised by your conversations that are waiting on a decision. Each one blocks a
              write to the knowledge base, and each one expires if it is never answered.
            </p>
          </div>

          {status === 'unavailable' ? (
            // Said plainly rather than rendered as an empty queue. "Nothing is waiting" and "we
            // could not find out" are different facts, and only one of them means you can stop
            // looking.
            <p role="status" className="rounded-lg border border-border-subtle p-3 text-sm">
              The approvals queue could not be read. Anything waiting is still waiting — this view
              cannot currently show it.
            </p>
          ) : holds.length === 0 ? (
            // Not `EmptyState`: it renders its title as an `h2`, which here would sit beside the
            // panel's own h2 as a sibling rather than under it, and say "Nothing waiting" at the
            // same level as the section it is inside.
            <p role="status" className="rounded-lg border border-border-subtle p-3 text-sm">
              Nothing waiting. Approval requests appear here as soon as the agent raises one.
            </p>
          ) : (
            <ul className="space-y-3">
              {holds.map((hold) => (
                <Hold
                  key={hold.approval_id}
                  approvalId={hold.approval_id}
                  question={hold.question}
                  // Marks it answered — which drops it from the count — and nothing more. The row
                  // itself is retired on close; see `onOpenChange`.
                  onDecided={() => setDecided((current) => new Set(current).add(hold.approval_id))}
                />
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
