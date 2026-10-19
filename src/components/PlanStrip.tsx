/**
 * The plan as one collapsible line: where the plan has got to, with the steps one click in. While
 * the turn runs it also carries the activity line, since "step 3 of 4" and "calling predict_pka"
 * describe one moment.
 *
 * It opens itself only for a pending approval: the decision is bound to the hash of the plan shown,
 * so the reader must see it. `[x] `/`[ ] ` prefixes are presentation (the hash covers bare step
 * text); `PlanItems` parses them and is the single rendering shared with the trace.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
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
  // Open when the approval arrives (mid-stream), not only on mount. Tracked so it fires on the
  // transition and does not fight a reader who closes it again.
  const wasAwaiting = useRef(awaitingApproval);
  useEffect(() => {
    if (awaitingApproval && !wasAwaiting.current) setOpen(true);
    wasAwaiting.current = awaitingApproval;
  }, [awaitingApproval]);

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
              {/* On a settled turn, count what the service reported: a turn can end with steps still open. */}
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
