/**
 * Status pills.
 *
 * Consolidates five inconsistent treatments — some bordered, some not, for the same semantic
 * ("converged" had no border while every other ok-coloured chip did).
 *
 * Every tone pairs a soft ground with its `-ink` text, so the pill stays readable in both themes
 * without a per-site contrast decision.
 */

import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  [
    'inline-flex w-fit shrink-0 items-center justify-center gap-1',
    'rounded-sm border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
    "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3",
  ],
  {
    variants: {
      tone: {
        neutral: 'border-border-subtle bg-surface-sunken text-ink-muted',
        brand: 'border-brand/40 bg-brand-soft text-brand-ink',
        ok: 'border-ok/40 bg-ok-soft text-ok-ink',
        warn: 'border-warn/40 bg-warn-soft text-warn-ink',
        danger: 'border-danger/40 bg-danger-soft text-danger-ink',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  asChild?: boolean;
}

export function Badge({
  className,
  tone,
  asChild = false,
  ...props
}: BadgeProps): React.JSX.Element {
  const Comp = asChild ? Slot.Root : 'span';
  return <Comp data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props} />;
}
