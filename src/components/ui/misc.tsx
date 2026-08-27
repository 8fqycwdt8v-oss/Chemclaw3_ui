/**
 * The small primitives — Collapsible, Switch, Label.
 *
 * Grouped in one file rather than four: each is a handful of lines, and the registry's
 * one-file-per-primitive layout only pays off when a CLI is writing them.
 *
 * Kept deliberately short of a component library: a primitive earns its place here by having a
 * caller. Popover, Separator and a full Dialog were written during the rebuild, went unused, and
 * were deleted rather than left as furniture.
 */

import { Collapsible as C, Label as L, Switch as W } from 'radix-ui';
import { cn } from '@/lib/utils';

/* ── Collapsible ─────────────────────────────────────────────────────────────
   Gives the trace panel `aria-expanded` and `aria-controls` for free — the hand-rolled
   toggle it replaces announced nothing about the state it controlled. */

export const Collapsible = C.Root;
export const CollapsibleTrigger = C.Trigger;
export const CollapsibleContent = C.Content;

/* ── Switch ──────────────────────────────────────────────────────────────────
   Replaces a bare <input type="checkbox">, which rendered as a light-mode control on a dark
   surface until `color-scheme` was declared, and offered no focus styling at all. */

export function Switch({
  className,
  ...props
}: React.ComponentProps<typeof W.Root>): React.JSX.Element {
  return (
    <W.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-4.5 w-8 shrink-0 items-center rounded-full border border-transparent transition-colors',
        // The unchecked track IS the control's boundary — there is nothing else to identify the
        // switch by — so it has to clear 3:1 against the surface (WCAG 2.2 SC 1.4.11).
        // `border-strong` is a divider colour and does not; `ink-subtle` does.
        'data-[state=checked]:bg-brand data-[state=unchecked]:bg-ink-subtle',
        'focus-ring',
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

export function Label({
  className,
  ...props
}: React.ComponentProps<typeof L.Root>): React.JSX.Element {
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
