/**
 * Confirmation for an irreversible action.
 *
 * The app had exactly one guard on anything destructive — a `window.confirm` on "Reset app" — and
 * none at all on the decisions that actually matter: approving a plan or a durable hold. Those are
 * one tap, cannot be undone, and in a GxP context are attributable to whoever clicked. The
 * fallback path was worse: it auto-sent "Approved — go ahead." into the chat with no review step,
 * which is the moment the plan gate exists to create.
 *
 * `window.confirm` is accessible but unstyleable, blocks the event loop, and is suppressible by
 * the browser. This is the same guarantee with the app's own type and colour.
 */

import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  variant = 'default',
  onConfirm,
}: {
  trigger: React.ReactNode;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  variant?: 'default' | 'destructive' | 'success';
  onConfirm: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction variant={variant} onClick={onConfirm}>
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
