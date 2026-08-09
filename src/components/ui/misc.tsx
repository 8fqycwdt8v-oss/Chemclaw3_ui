/**
 * The small primitives — Popover, Collapsible, Separator, Skeleton, Switch, Label.
 *
 * Grouped in one file rather than six: each is a handful of lines, and the registry's
 * one-file-per-primitive layout only pays off when a CLI is writing them.
 */

import { Collapsible as C, Label as L, Popover as P, Separator as S, Switch as W } from 'radix-ui';
import { cn } from '@/lib/utils';

/* ── Popover ─────────────────────────────────────────────────────────────── */

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;

export function PopoverContent({
  className,
  align = 'center',
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof P.Content>): React.JSX.Element {
  return (
    <P.Portal>
      <P.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 w-72 rounded-lg border border-border-subtle bg-surface-overlay p-3 shadow-md outline-none',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          className,
        )}
        {...props}
      />
    </P.Portal>
  );
}

/* ── Collapsible ─────────────────────────────────────────────────────────────
   Gives the trace panel `aria-expanded` and `aria-controls` for free — the hand-rolled
   toggle it replaces announced nothing about the state it controlled. */

export const Collapsible = C.Root;
export const CollapsibleTrigger = C.Trigger;
export const CollapsibleContent = C.Content;

/* ── Separator ───────────────────────────────────────────────────────────── */

export function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: React.ComponentProps<typeof S.Root>): React.JSX.Element {
  return (
    <S.Root
      decorative={decorative}
      orientation={orientation}
      className={cn(
        'shrink-0 bg-border-subtle',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  );
}

/* ── Skeleton ────────────────────────────────────────────────────────────────
   Reserves the space its content will occupy. The point is no layout shift when the real
   thing lands, so callers give it the real dimensions. */

export function Skeleton({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="skeleton"
      className={cn('animate-pulse rounded-md bg-surface-sunken', className)}
      {...props}
    />
  );
}

/* ── Switch ──────────────────────────────────────────────────────────────────
   Replaces a bare <input type="checkbox">, which rendered as a light-mode control on a dark
   surface until `color-scheme` was declared, and offered no focus styling at all. */

export function Switch({ className, ...props }: React.ComponentProps<typeof W.Root>): React.JSX.Element {
  return (
    <W.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-4.5 w-8 shrink-0 items-center rounded-full border border-transparent transition-colors',
        // The unchecked track IS the control's boundary — there is nothing else to identify the
        // switch by — so it has to clear 3:1 against the surface (WCAG 2.2 SC 1.4.11).
        // `border-strong` is a divider colour and does not; `ink-subtle` does.
        'data-[state=checked]:bg-brand data-[state=unchecked]:bg-ink-subtle',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <W.Thumb
        className={cn(
          'pointer-events-none block size-3.5 rounded-full bg-surface-raised shadow-xs ring-0 transition-transform',
          'data-[state=checked]:translate-x-[1.125rem] data-[state=unchecked]:translate-x-0.5',
        )}
      />
    </W.Root>
  );
}

/* ── Label ───────────────────────────────────────────────────────────────── */

export function Label({ className, ...props }: React.ComponentProps<typeof L.Root>): React.JSX.Element {
  return (
    <L.Root
      data-slot="label"
      className={cn(
        'flex items-center gap-1.5 text-sm leading-none font-medium select-none',
        'peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
