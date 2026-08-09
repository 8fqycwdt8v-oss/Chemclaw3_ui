/**
 * Service / session status.
 *
 * Colour is never the only carrier: each state has a distinct shape as well as a hue, and a text
 * label that is either visible or screen-reader-only. The sidebar's "server session was replaced"
 * marker used to be an amber dot with a `title` — invisible to touch users, unavailable to most
 * screen-reader configurations, and meaningless to anyone who cannot separate amber from grey.
 */

import { cn } from '@/lib/utils';

export type Status = 'ok' | 'warn' | 'down' | 'pending';

const TONE: Record<Status, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  down: 'bg-danger',
  pending: 'bg-ink-subtle',
};

/** Shape differs per state so the signal survives a monochrome or colour-blind reading. */
const SHAPE: Record<Status, string> = {
  ok: 'rounded-full',
  warn: 'rounded-[1px] rotate-45',
  down: 'rounded-[1px]',
  pending: 'rounded-full opacity-60',
};

export function StatusDot({
  status,
  label,
  showLabel = true,
  className,
}: {
  status: Status;
  label: string;
  /** When false the label is still rendered, just only for assistive tech. */
  showLabel?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs text-ink-muted', className)}>
      <span
        aria-hidden
        className={cn(
          'size-2 shrink-0',
          TONE[status],
          SHAPE[status],
          status === 'pending' && 'animate-pulse',
        )}
      />
      <span className={showLabel ? undefined : 'sr-only-live'}>{label}</span>
    </span>
  );
}
