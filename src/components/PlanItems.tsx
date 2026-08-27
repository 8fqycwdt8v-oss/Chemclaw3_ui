/**
 * The one rendering of a plan's steps, shared by the answer's checklist and the trace's
 * "Plan revised" rows so the two cannot drift.
 *
 * The service deliberately encodes each step's completion state as a leading `[x] ` / `[ ] `
 * prefix on the line — its `plan` event re-emits on every status flip precisely so a surface can
 * show steps ticking over, and this list used to render that prefix as literal text beside a
 * decorative square that never filled. The prefix is presentation, not identity: the plan's hash
 * is computed over the bare step text on the service side, which is what makes parsing it off
 * here safe for the approval binding.
 *
 * A line without the prefix renders as a plain bullet rather than an unchecked box: the
 * `GET /sessions/{id}/plan` route returns bare step text with no status, and a checkbox drawn
 * for it would claim a completion state nobody reported.
 */

import { Check, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PlanStepJobStatus } from '../state/planJobs.ts';

export type PlanItem = { status: 'done' | 'open' | 'plain'; text: string };

/** One streamed plan line, split into the status the prefix encodes and the step's own text. */
export function parsePlanItem(line: string): PlanItem {
  if (line.startsWith('[x] ')) return { status: 'done', text: line.slice(4) };
  if (line.startsWith('[ ] ')) return { status: 'open', text: line.slice(4) };
  return { status: 'plain', text: line };
}

/**
 * The chip a step wears while a durable job runs for it, and after that job ends.
 *
 * Matched on the step's bare text because that is what the service stamps on the job
 * (`JobStartedEvent.plan_step` is the todo's content, not the rendered `[x] ` line) — so parsing
 * the checkbox prefix off first is what makes the join line up.
 */
function JobChip({ status }: { status: PlanStepJobStatus }): React.JSX.Element {
  return (
    <span
      className={cn(
        'ml-2 inline-flex items-center gap-1 rounded-full border px-1.5 py-px align-middle',
        'text-2xs',
        status === 'failed'
          ? 'border-danger/40 text-danger-ink'
          : 'border-border-subtle text-ink-muted',
      )}
    >
      {status === 'running' && <Loader2 className="size-2.5 animate-spin" aria-hidden />}
      {status === 'done' && <Check className="size-2.5" strokeWidth={3} aria-hidden />}
      {status === 'failed' && <X className="size-2.5" strokeWidth={3} aria-hidden />}
      {status === 'running' ? 'job running' : status === 'done' ? 'job done' : 'job failed'}
    </span>
  );
}

export function PlanItems({
  todos,
  jobs,
}: {
  todos: string[];
  /** Step text → the state of the durable job(s) behind it; steps not in the map wear no chip. */
  jobs?: ReadonlyMap<string, PlanStepJobStatus>;
}): React.JSX.Element {
  return (
    <ul className="space-y-1">
      {todos.map((line, i) => {
        const item = parsePlanItem(line);
        return (
          <li key={i} className="flex gap-2 text-sm">
            {item.status === 'plain' ? (
              <span
                aria-hidden
                className="mt-1.5 size-1.5 shrink-0 rounded-[1px] border border-ink-subtle"
              />
            ) : (
              <span
                aria-hidden
                className={cn(
                  'mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-[3px]',
                  'border border-ink-subtle',
                  item.status === 'done' && 'bg-ink-subtle/20 text-ink-muted',
                )}
              >
                {item.status === 'done' && <Check className="size-2.5" strokeWidth={3} />}
              </span>
            )}
            <span className={cn(item.status === 'done' && 'text-ink-muted line-through')}>
              {/* The visual state above is aria-hidden; this is the same fact for a reader. */}
              {item.status !== 'plain' && (
                <span className="sr-only">{item.status === 'done' ? 'Done: ' : 'To do: '}</span>
              )}
              {item.text}
              {(() => {
                const job = jobs?.get(item.text);
                return job ? <JobChip status={job} /> : null;
              })()}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
