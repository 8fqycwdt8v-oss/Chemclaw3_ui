/**
 * Edge-anchored panel. Used for the conversation list below `lg`, where the sidebar has nowhere
 * to live — it previously just `display:none`d, taking the conversation switcher, "New
 * conversation" and the "Reset app" recovery control off the phone entirely.
 */

import { Dialog as D } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Sheet = D.Root;
export const SheetTrigger = D.Trigger;

const SIDE = {
  left: [
    'inset-y-0 left-0 h-full w-[min(20rem,85vw)] border-r',
    'data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left',
  ].join(' '),
  right: [
    'inset-y-0 right-0 h-full w-[min(20rem,85vw)] border-l',
    'data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right',
  ].join(' '),
  bottom: [
    'inset-x-0 bottom-0 max-h-[80svh] rounded-t-xl border-t',
    'data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom',
  ].join(' '),
} as const;

export function SheetContent({
  className,
  children,
  side = 'left',
  title,
  ...props
}: React.ComponentProps<typeof D.Content> & {
  side?: keyof typeof SIDE;
  /** Required: Radix warns without a title, and a screen reader needs the panel named. */
  title: string;
}): React.JSX.Element {
  return (
    <D.Portal>
      <D.Overlay
        className={cn(
          'fixed inset-0 z-50 bg-ink/25 backdrop-blur-[2px]',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
        )}
      />
      <D.Content
        data-slot="sheet-content"
        className={cn(
          'fixed z-50 flex flex-col bg-surface-raised shadow-lg',
          'transition ease-out data-[state=closed]:duration-200 data-[state=open]:duration-300',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          // The drawer runs to the physical edge, so its own padding has to clear the notch.
          'pb-[env(safe-area-inset-bottom)]',
          SIDE[side],
          className,
        )}
        {...props}
      >
        <D.Title className="sr-only-live">{title}</D.Title>
        <D.Close
          aria-label="Close"
          className={cn(
            'tap-target absolute top-3 right-3 rounded-sm text-ink-muted transition-colors',
            'hover:text-ink focus-ring',
          )}
        >
          <X className="size-4" />
        </D.Close>
        {children}
      </D.Content>
    </D.Portal>
  );
}
