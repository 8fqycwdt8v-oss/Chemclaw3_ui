/**
 * The three pieces every workbench view needs, so four files do not each invent them.
 *
 * Kept deliberately small. This is not a component library and the workbench is not an admin
 * console: a page frame, a tone callout in the codebase's existing idiom
 * (`border-<tone>/40 bg-<tone>-soft text-<tone>`), and a state pill.
 */

import { cn } from '../lib/cn.ts';

export type Tone = 'ok' | 'warn' | 'danger' | 'accent' | 'neutral';

export function Page({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  /** One line saying what this surface *is*, where the name alone would mislead. */
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-5 py-5">
        <div className="mb-4 flex items-start gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold">{title}</h1>
            {subtitle && <p className="mt-0.5 text-sm text-ink-muted">{subtitle}</p>}
          </div>
          {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

const CALLOUT: Record<Tone, string> = {
  ok: 'border-ok/40 bg-ok-soft text-ok',
  warn: 'border-warn/40 bg-warn-soft text-warn',
  danger: 'border-danger/40 bg-danger-soft text-danger',
  accent: 'border-accent/40 bg-accent-soft text-accent',
  neutral: 'border-border-subtle bg-surface-sunken text-ink-muted',
};

export function Callout({
  tone,
  title,
  children,
}: {
  tone: Tone;
  title?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={cn('rounded-md border p-3 text-sm', CALLOUT[tone])}>
      {title && <p className="font-medium">{title}</p>}
      {children && <div className={cn('text-sm', title && 'mt-1')}>{children}</div>}
    </div>
  );
}

export function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }): React.JSX.Element {
  return (
    <span className={cn('rounded border px-1.5 py-0.5 text-xs whitespace-nowrap', CALLOUT[tone])}>
      {children}
    </span>
  );
}

export function Button({
  onClick,
  disabled,
  tone = 'neutral',
  children,
  title,
}: {
  onClick: () => void;
  disabled?: boolean;
  tone?: Tone;
  children: React.ReactNode;
  title?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'rounded border px-2.5 py-1 text-sm transition-colors',
        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        tone === 'neutral'
          ? 'border-border-subtle bg-surface-raised hover:brightness-95'
          : cn(CALLOUT[tone], 'hover:brightness-95'),
      )}
    >
      {children}
    </button>
  );
}

/** An absolute timestamp rendered in the reader's locale, or a dash. Deliberately not relative:
 *  a run that finished "3d ago" is a fine thing to skim, but a reviewer citing a decision needs
 *  the date, and these views are read by both. */
export function When({ iso }: { iso?: string | null }): React.JSX.Element {
  if (!iso) return <span className="text-ink-muted">—</span>;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return <span className="text-ink-muted">{iso}</span>;
  return (
    <time dateTime={iso} className="text-ink-muted">
      {new Date(parsed).toLocaleString()}
    </time>
  );
}
