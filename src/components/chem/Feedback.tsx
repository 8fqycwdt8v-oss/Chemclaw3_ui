/**
 * The shared vocabulary for "something is happening" and "there is nothing here yet".
 *
 * The app previously had five loading sentences in three treatments — "Starting…",
 * "Starting a conversation…", "Thinking…", "Reading the plan…", "running…" — each styled
 * independently, none with a spinner or a reserved space. A reader could not tell which of them
 * meant "a request is in flight" and which meant "we are waiting on the agent".
 */

import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

function Spinner({ className }: { className?: string }): React.JSX.Element {
  // aria-hidden: the surrounding live region announces the state in words. A spinner that also
  // announces itself gives a screen reader two versions of the same fact.
  return <Loader2 aria-hidden className={cn('size-4 animate-spin text-ink-subtle', className)} />;
}

export function Loading({
  children,
  className,
  size = 'sm',
}: {
  children: React.ReactNode;
  className?: string;
  size?: 'xs' | 'sm';
}): React.JSX.Element {
  return (
    <p
      className={cn(
        'flex items-center gap-2 text-ink-muted',
        size === 'xs' ? 'text-xs' : 'text-sm',
        className,
      )}
    >
      <Spinner className={size === 'xs' ? 'size-3' : 'size-4'} />
      {children}
    </p>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  children?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('flex flex-col items-center px-6 py-16 text-center', className)}>
      {icon && (
        <div
          aria-hidden
          className="mb-4 flex size-11 items-center justify-center rounded-xl border border-border-subtle bg-surface-raised text-brand shadow-xs"
        >
          {icon}
        </div>
      )}
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {children && <div className="mt-1.5 max-w-md text-sm text-ink-muted">{children}</div>}
    </div>
  );
}
