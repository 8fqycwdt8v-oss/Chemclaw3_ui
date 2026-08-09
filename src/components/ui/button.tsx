/**
 * The button.
 *
 * This replaces fourteen distinct ad-hoc treatments that had grown across twenty buttons — three
 * different "primary" fills with three radii, three padding pairs and two disabled opacities, plus
 * a "Dismiss" control styled as bare text with no affordance at all.
 *
 * Two things are deliberately baked into the base rather than left to callers:
 *
 *  - The focus ring. Previously exactly one control in the app had one, and the composer textarea
 *    set `outline-none` with nothing in its place.
 *  - The disabled treatment. `opacity-40`/`opacity-50` made the label unreadable; WCAG exempts
 *    inactive controls from contrast, but a Send button you cannot read is a support ticket. A
 *    muted fill says "not now" and stays legible.
 *
 * Written against Radix directly rather than pulled from the shadcn registry (unreachable from
 * this network), but kept API-compatible with it: same variant/size names, same `asChild`, same
 * `data-slot`, so a later `shadcn add` diffs cleanly against these.
 */

import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

export const buttonVariants = cva(
  [
    'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap',
    'rounded-md font-medium transition-[color,background-color,border-color,box-shadow] duration-150',
    'outline-none focus-ring',
    'disabled:pointer-events-none disabled:border-transparent disabled:bg-surface-sunken',
    'disabled:text-ink-subtle disabled:shadow-none',
    "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        default: 'bg-brand text-brand-fg shadow-xs hover:bg-brand/90 active:bg-brand/95',
        success: 'bg-ok text-ok-fg shadow-xs hover:bg-ok/90',
        destructive: 'bg-danger text-danger-fg shadow-xs hover:bg-danger/90',
        outline:
          'border border-border-subtle bg-surface-raised text-ink shadow-2xs hover:bg-surface-sunken hover:border-border-strong',
        'outline-destructive':
          'border border-danger/40 bg-transparent text-danger-ink hover:bg-danger-soft hover:border-danger/60',
        secondary: 'bg-surface-sunken text-ink hover:bg-surface-sunken/70',
        ghost: 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
        link: 'text-ink-muted underline underline-offset-2 hover:text-ink',
      },
      size: {
        xs: 'h-6 gap-1 rounded-sm px-2 text-xs',
        sm: 'h-8 px-3 text-sm',
        default: 'h-9 px-4 text-sm',
        lg: 'h-10 px-5 text-base',
        'icon-xs': 'size-6 rounded-sm p-0 [&_svg:not([class*=size-])]:size-3.5',
        'icon-sm': 'size-8 p-0',
        icon: 'size-9 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  type,
  ...props
}: ButtonProps): React.JSX.Element {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      data-slot="button"
      // Defaulting to "button" rather than inheriting the HTML default of "submit": this app has
      // no <form>, and a stray submit inside one later would reload the page mid-turn.
      {...(asChild ? {} : { type: type ?? 'button' })}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
