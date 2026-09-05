/**
 * The list of keys, because a shortcut nobody can find is not a feature.
 *
 * Bound to `?` for the same reason every application binds it there: it is the one key a reader
 * tries when they suspect there are shortcuts and have nowhere to look. Rendered from the same
 * array the handler runs, so a binding cannot be added, changed or removed without this list
 * following — the failure a hand-written help panel has is that it describes last month's keys.
 */

import { describeShortcut, type Shortcut } from '../hooks/useShortcuts.ts';
import { Sheet, SheetContent } from '@/components/ui/sheet';

export function ShortcutSheet({
  shortcuts,
  open,
  onOpenChange,
}: {
  shortcuts: Shortcut[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" title="Keyboard shortcuts" className="w-[min(24rem,92vw)]">
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
          <div>
            <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
            <p className="mt-1 text-xs text-ink-muted">
              None of these fire while you are typing, so a compound name with a{' '}
              <span className="font-mono">k</span> in it is safe.
            </p>
          </div>
          <dl className="flex flex-col gap-2">
            {shortcuts.map((shortcut) => (
              <div key={shortcut.label} className="flex items-baseline justify-between gap-4">
                <dt className="text-sm">{shortcut.label}</dt>
                <dd className="shrink-0 rounded border border-border-subtle bg-surface-sunken px-1.5 py-0.5 font-mono text-2xs">
                  {describeShortcut(shortcut)}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-ink-muted">
            {/* Said rather than bound: Radix owns Escape for every sheet, dialog and menu here, and
                a global handler would race them. Stop is a visible control and stays one. */}
            Escape closes whatever is open. Stopping a turn is the button beside the composer.
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
