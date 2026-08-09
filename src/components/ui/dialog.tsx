/**
 * Modal dialog. Radix supplies the focus trap, Escape handling, scroll lock and `aria-modal`.
 */

import { Dialog as D } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof D.Overlay>): React.JSX.Element {
  return (
    <D.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-ink/25 backdrop-blur-[2px]',
        'data-[state=open]:animate-in data-[state=open]:fade-in-0',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
        className,
      )}
      {...props}
    />
  );
}

export function DialogContent({
  className,
  children,
  showClose = true,
  ...props
}: React.ComponentProps<typeof D.Content> & { showClose?: boolean }): React.JSX.Element {
  return (
    <D.Portal>
      <DialogOverlay />
      <D.Content
        data-slot="dialog-content"
        className={cn(
          'fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2',
          'gap-4 rounded-xl border border-border-subtle bg-surface-overlay p-5 shadow-lg',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          className,
        )}
        {...props}
      >
        {children}
        {showClose && (
          <D.Close
            aria-label="Close"
            className={cn(
              'tap-target absolute top-3.5 right-3.5 rounded-sm text-ink-muted transition-colors',
              'hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            )}
          >
            <X className="size-4" />
          </D.Close>
        )}
      </D.Content>
    </D.Portal>
  );
}

export function DialogHeader({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return <div data-slot="dialog-header" className={cn('flex flex-col gap-1.5 pr-6', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

export function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof D.Title>): React.JSX.Element {
  return <D.Title data-slot="dialog-title" className={cn('text-base font-semibold', className)} {...props} />;
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof D.Description>): React.JSX.Element {
  return (
    <D.Description
      data-slot="dialog-description"
      className={cn('text-sm text-ink-muted', className)}
      {...props}
    />
  );
}
