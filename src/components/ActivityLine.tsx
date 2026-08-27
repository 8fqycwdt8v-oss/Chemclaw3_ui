/**
 * What the turn is doing, as one row that mutates.
 *
 * The surface this replaces was a growing list and a counter: "Thinking…" until the first token,
 * then nothing, with a collapsed disclosure quietly ticking 3 → 4 → 5 steps. A chemist waiting on
 * a turn that takes minutes could not see which step of the plan was running, which tool was out,
 * or whether the wait was the model or a conformer search — every one of which was already in the
 * store.
 *
 * It is deliberately ONE row and never grows. A live log is a second transcript competing with the
 * answer for the reader's attention, and it re-lays-out the page every time it gains a line; a row
 * that changes its own text costs nothing and can be read in a glance without leaving the answer.
 *
 * ## No live region here, and that is the house rule rather than an oversight
 *
 * `state/announce.ts` owns everything a screen reader hears: transitions only, one short sentence
 * each, through the app's single polite region. This row sits inside the bubble's `aria-busy`
 * container, so a reader is told the turn is working and can navigate to this row deliberately —
 * rather than having every state change queued and read over the answer they are trying to hear.
 */

import type { AssistantMessage } from '../state/types.ts';
import { turnActivity, type TurnActivity } from '../state/turnActivity.ts';
import { ElapsedTimer } from '@/components/chem/ElapsedTimer';
import { cn } from '@/lib/utils';

/**
 * The state dot.
 *
 * Two tones, and the difference is who is being waited on. `busy` pulses because this process is
 * doing something; `waiting` does not, because an admission queue and a durable job finish on
 * somebody else's clock and a pulse would imply progress nobody can see.
 */
function ActivityDot({ tone }: { tone: TurnActivity['tone'] }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        tone === 'busy' ? 'animate-pulse bg-brand' : 'bg-ink-subtle',
      )}
    />
  );
}

/**
 * The row itself, without any container.
 *
 * Shared by the bare form below and by `PlanStrip`, which puts the same row behind a disclosure so
 * a turn with a plan has one live line rather than two that say the same thing differently.
 *
 * `showStep` is off where the caller already renders the plan position — the strip draws a segment
 * bar and the step's own text, so repeating "step 3 of 4" inside the row would be the duplication
 * this whole component exists to remove.
 */
export function ActivityRow({
  message,
  showStep = true,
  className,
}: {
  message: AssistantMessage;
  showStep?: boolean;
  className?: string;
}): React.JSX.Element {
  const activity = turnActivity(message);
  return (
    <span
      className={cn('flex min-w-0 flex-1 items-center gap-2 text-sm text-ink-muted', className)}
    >
      <ActivityDot tone={activity.tone} />
      {showStep && activity.step && (
        <span className="shrink-0 text-2xs text-ink-subtle tabular-nums">
          Step {activity.step.index} of {activity.step.total}
        </span>
      )}
      <span className="truncate text-ink">{activity.label}</span>
      {activity.detail && (
        <span className="hidden truncate font-mono text-2xs text-ink-subtle sm:inline">
          {activity.detail}
        </span>
      )}
      {/* A sibling node, never concatenated into the sentence: a ten-minute turn needs a sign of
          life, and the sentence itself has to stay one stable string. */}
      <ElapsedTimer since={message.at} className="ml-auto shrink-0" />
    </span>
  );
}

/**
 * The bare row, for a turn with no plan to hang it on.
 *
 * Harness mode is what emits `plan`, so most deployments never see a checklist and this is the
 * only live progress they get. Renders nothing once the turn has settled — a finished turn is
 * described by the summary on the trace disclosure, which is the same facts in the past tense.
 */
export function ActivityLine({ message }: { message: AssistantMessage }): React.JSX.Element | null {
  if (message.status !== 'streaming') return null;
  return (
    <div className="mb-3 flex items-center rounded-lg border border-border-subtle bg-surface-sunken px-3 py-2">
      <ActivityRow message={message} />
    </div>
  );
}
