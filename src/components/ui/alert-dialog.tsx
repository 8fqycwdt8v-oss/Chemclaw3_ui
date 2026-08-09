/**
 * Confirmation dialog.
 *
 * Distinct from Dialog: `role="alertdialog"`, no click-outside dismissal, and focus lands on the
 * cancel action. That is the right shape for the decisions this app asks for — approving a plan or
 * a durable hold is irreversible and, in a GxP context, attributable.
 */

import { AlertDialog as A } from 'radix-ui';
import { cn } from '@/lib/utils';
import { buttonVariants } from './button';

export const AlertDialog = A.Root;
export const AlertDialogTrigger = A.Trigger;

export function AlertDialogContent({
  className,
  ...props
}: React.ComponentProps<typeof A.Content>): React.JSX.Element {
  return (
    <A.Portal>
      <A.Overlay
        className={cn(
          'fixed inset-0 z-50 bg-ink/25 backdrop-blur-[2px]',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
        )}
      />
      <A.Content
        data-slot="alert-dialog-content"
        className={cn(
          'fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2',
          'gap-4 rounded-xl border border-border-subtle bg-surface-overlay p-5 shadow-lg',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          className,
        )}
        {...props}
      />
    </A.Portal>
  );
}

export function AlertDialogHeader({
  className,
  ...props
}: React.ComponentProps<'div'>): React.JSX.Element {
  return <div className={cn('flex flex-col gap-1.5', className)} {...props} />;
}

export function AlertDialogFooter({
  className,
  ...props
}: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

export function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof A.Title>): React.JSX.Element {
  return <A.Title className={cn('text-base font-semibold', className)} {...props} />;
}

export function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof A.Description>): React.JSX.Element {
  return <A.Description className={cn('text-sm text-ink-muted', className)} {...props} />;
}

export function AlertDialogAction({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof A.Action> & {
  variant?: 'default' | 'destructive' | 'success';
}): React.JSX.Element {
  return <A.Action className={cn(buttonVariants({ variant, size: 'sm' }), className)} {...props} />;
}

export function AlertDialogCancel({
  className,
  ...props
}: React.ComponentProps<typeof A.Cancel>): React.JSX.Element {
  return (
    <A.Cancel
      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), className)}
      {...props}
    />
  );
}
