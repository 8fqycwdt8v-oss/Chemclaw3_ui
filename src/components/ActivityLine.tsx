/**
 * What the turn is doing, as one row that changes in place (never a growing log): the plan step,
 * the tool out, the durable job, and the elapsed time. Announced through `state/announce.ts`'s
 * single polite region on a change of kind, never via its own `aria-live` (the row carries a
 * ticking timer).
 */

import { useEffect, useRef } from 'react';
import type { AssistantMessage } from '../state/types.ts';
import { describeActivity, turnActivity, type TurnActivity } from '../state/turnActivity.ts';
import { announceStatus } from '../state/announce.ts';
import { ElapsedTimer } from '@/components/chem/ElapsedTimer';
import { cn } from '@/lib/utils';

/** The state dot: `busy` pulses; `waiting` (admission queue, durable job) does not. */
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
 * The row without a container, shared with `PlanStrip`. `showStep` is off where the caller already
 * shows the plan position.
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
  // In an effect, not in render: announcing is a side effect, and React may render this row for
  // reasons that are not a state change at all.
  const announced = useRef<string | null>(null);
  const streaming = message.status === 'streaming';
  /*
   * The announcement effect depends on two strings (`kind` and the sentence, derived in render),
   * not the activity object, which is new every render.
   */
  const kind = activity.kind;
  const sentence = describeActivity(activity);
  useEffect(() => {
    if (!streaming) return;
    if (announced.current === kind) return;
    announced.current = kind;
    announceStatus(sentence);
  }, [streaming, kind, sentence]);

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
      {/* No frame for a long while: a note (not an abort) that disappears when a frame arrives. */}
      {message.stalled && (
        <span className="shrink-0 text-2xs text-warn-ink">no activity for 90 s</span>
      )}
    </span>
  );
}

/**
 * The bare row for a turn with no plan. Renders nothing once settled (the trace summary takes
 * over).
 */
export function ActivityLine({ message }: { message: AssistantMessage }): React.JSX.Element | null {
  if (message.status !== 'streaming') return null;
  return (
    <div className="mb-3 flex items-center rounded-lg border border-border-subtle bg-surface-sunken px-3 py-2">
      <ActivityRow message={message} />
    </div>
  );
}
