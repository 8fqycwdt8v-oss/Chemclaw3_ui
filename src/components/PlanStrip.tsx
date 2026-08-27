/**
 * The plan, as one line you can open.
 *
 * The card this replaces printed every step above every answer, always expanded, for the whole
 * life of the conversation — 90-odd pixels of checklist over a two-line answer, and on a phone the
 * first half of the screen. The steps are worth having; they are not worth having *first*, every
 * time, at the cost of the thing the chemist asked for.
 *
 * So the strip states the one fact a reader wants at a glance — where the plan has got to — and
 * holds the rest one click in. While the turn runs it is also the live row: the activity line is
 * folded into the same strip rather than sitting beside it, because "step 3 of 4" and "calling
 * predict_pka" are one sentence about one moment and two rows saying it is one row too many.
 *
 * ## It opens itself exactly once
 *
 * A pending approval opens it, and nothing else does. `POST /sessions/{id}/plan/decision` binds a
 * decision to the hash of the plan that was shown, so a reader being asked to approve a plan must
 * be able to see the plan without hunting for it. Every other turn starts collapsed.
 *
 * The status prefixes are presentation, not identity: the service encodes completion as `[x] `/
 * `[ ] ` on the line, and the hash it signs is computed over the bare step text. `PlanItems` is
 * where that parsing lives, and it stays the single rendering of a step so the strip and the trace
 * cannot drift.
 */

import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { AssistantMessage, TraceEntry } from '../state/types.ts';
import { planPosition } from '../state/turnActivity.ts';
import { planStepJobs } from '../state/planJobs.ts';
import { parsePlanItem, PlanItems } from './PlanItems.tsx';
import { ActivityRow } from './ActivityLine.tsx';
import { useChatStore } from '../state/chatStore.ts';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/misc';
import { cn } from '@/lib/utils';

/** Above this many steps a per-step segment is a hairline nobody can read, so the bar becomes a
 *  single proportional track. Both forms answer the same question; only one of them is legible. */
const MAX_SEGMENTS = 8;

function ProgressBar({ done, total }: { done: number; total: number }): React.JSX.Element {
  // The text beside it carries the same fact for anyone not looking at colours.
  if (total <= MAX_SEGMENTS) {
    return (
      <span aria-hidden className="flex shrink-0 gap-[3px]">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={cn(
              'block h-1 w-3.5 rounded-full',
              i < done ? 'bg-ok' : 'bg-border-strong',
              i === done && 'bg-brand',
            )}
          />
        ))}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="block h-1 w-16 shrink-0 overflow-hidden rounded-full bg-border-strong"
    >
      <span
        className="block h-full rounded-full bg-brand"
        style={{ width: `${Math.round((done / total) * 100)}%` }}
      />
    </span>
  );
}

export function PlanStrip({
  message,
  /** The message's own trace — where `job_started` rows carry the step a launch served. */
  trace,
}: {
  message: AssistantMessage;
  trace: TraceEntry[];
}): React.JSX.Element | null {
  const todos = message.latestPlan;
  // The global feed, because a durable job's ending usually arrives *after* the turn, through the
  // session's event stream — reading only the trace would leave a chip spinning forever for
  // exactly the jobs the chip matters for (see `planStepJobs`).
  const jobFeed = useChatStore((s) => s.jobFeed);
  const jobs = useMemo(() => planStepJobs(trace, jobFeed), [trace, jobFeed]);
  const awaitingApproval = trace.some((e) => e.kind === 'approval_request');
  const [open, setOpen] = useState(awaitingApproval);

  if (!todos || todos.length === 0) return null;

  const items = todos.map(parsePlanItem);
  const done = items.filter((i) => i.status === 'done').length;
  const position = planPosition(todos);
  const streaming = message.status === 'streaming';

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/plan mb-3">
      <CollapsibleTrigger
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg border border-border-subtle bg-surface-sunken',
          'px-3 py-2 text-left transition-colors hover:border-border-strong focus-ring',
        )}
      >
        <ProgressBar done={streaming ? done : items.length} total={items.length} />
        {/* Said in both tenses, so the control names itself whatever it is currently showing —
            while a turn runs the rest of this row is the live activity, which never says "plan". */}
        <span className="shrink-0 text-2xs tracking-wide text-ink-subtle uppercase">Plan</span>
        {streaming ? (
          // One live row, folded in: the strip already draws where the plan is, so the row does
          // not repeat it.
          <ActivityRow message={message} showStep={false} />
        ) : (
          <span className="flex min-w-0 flex-1 items-baseline gap-2 text-sm">
            <span className="truncate text-ink-muted">
              {/* Past tense on a settled turn, and it counts what the service reported rather
                  than assuming a finished turn finished its plan: a turn can end with steps
                  still open, and saying "4 of 4" over three ticked boxes would be a lie the
                  checklist below immediately contradicts. */}
              {position
                ? `${done} of ${items.length} steps done`
                : `${items.length} step${items.length === 1 ? '' : 's'}`}
            </span>
          </span>
        )}
        <ChevronRight
          aria-hidden
          className="size-3.5 shrink-0 text-ink-subtle transition-transform group-data-[state=open]/plan:rotate-90"
        />
      </CollapsibleTrigger>

      <CollapsibleContent
        className={cn(
          'overflow-hidden',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
        )}
      >
        <div className="mt-1.5 rounded-lg border border-border-subtle bg-surface-sunken px-3 py-2.5">
          <PlanItems todos={todos} jobs={jobs} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
