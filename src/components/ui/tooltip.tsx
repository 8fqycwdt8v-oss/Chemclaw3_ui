/**
 * Tooltip.
 *
 * Replaces eleven `title` attributes that were the *only* affordance for their control — invisible
 * on touch, unreliable through assistive tech, and unstyleable.
 *
 * A tooltip supplies `aria-describedby`, never the accessible name. Icon-only triggers still need
 * their own `aria-label`.
 */

import { Tooltip as T } from 'radix-ui';
import { cn } from '@/lib/utils';

export function TooltipProvider({
  delayDuration = 300,
  ...props
}: React.ComponentProps<typeof T.Provider>): React.JSX.Element {
  return <T.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />;
}

/**
 * Carries its own provider.
 *
 * Radix's Root throws without a `Tooltip.Provider` somewhere above it, which makes a tooltip a
 * component you cannot drop into a subtree — or render in a unit test — without also knowing about
 * an ancestor several files away. Nested providers are supported, so the app-level one still sets
 * the shared delay for anything below it and this one covers the rest.
 */
export function Tooltip(props: React.ComponentProps<typeof T.Root>): React.JSX.Element {
  return (
    <T.Provider delayDuration={300}>
      <T.Root data-slot="tooltip" {...props} />
    </T.Provider>
  );
}

export function TooltipTrigger(props: React.ComponentProps<typeof T.Trigger>): React.JSX.Element {
  return <T.Trigger data-slot="tooltip-trigger" {...props} />;
}

export function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof T.Content>): React.JSX.Element {
  return (
    <T.Portal>
      <T.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'z-50 max-w-64 rounded-md border border-border-subtle bg-surface-overlay px-2.5 py-1.5',
          'text-xs text-ink shadow-md',
          'animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          'data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1',
          'data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1',
          className,
        )}
        {...props}
      >
        {children}
      </T.Content>
    </T.Portal>
  );
}
