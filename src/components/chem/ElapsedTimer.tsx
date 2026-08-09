/**
 * How long the current turn has been running.
 *
 * A turn can legitimately occupy the backend's full 600s wall clock. Until now the reader saw an
 * unchanging "Thinking…" for the whole of it, which is indistinguishable from a hang — and the
 * honest thing to do about a long wait is to show that it is still moving.
 *
 * Rendered as a SIBLING of the status sentence, never concatenated into it. Two reasons: the
 * transcript tests match "Thinking…" exactly, and a live region should not re-announce a whole
 * sentence every second because a digit changed.
 */

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

const format = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

export function ElapsedTimer({
  since,
  className,
  /** Only start showing a timer once a wait is long enough to be worth remarking on. */
  appearAfterMs = 4000,
}: {
  since: number;
  className?: string;
  appearAfterMs?: number;
}): React.JSX.Element | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const elapsed = now - since;
  if (elapsed < appearAfterMs) return null;

  return (
    <span
      // The elapsed time is decoration on an already-announced state; a screen reader that read
      // it every second would drown out everything else.
      aria-hidden
      className={cn('font-mono text-xs tabular-nums text-ink-subtle', className)}
    >
      {format(Math.floor(elapsed / 1000))}
    </span>
  );
}
