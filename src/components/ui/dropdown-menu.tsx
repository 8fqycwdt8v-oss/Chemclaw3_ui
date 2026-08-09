/**
 * Dropdown menu. Carries the account controls and the per-conversation actions — including
 * `deleteConversation`, which the store has always implemented and no UI ever called.
 */

import { DropdownMenu as M } from 'radix-ui';
import { cn } from '@/lib/utils';

export const DropdownMenu = M.Root;
export const DropdownMenuTrigger = M.Trigger;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof M.Content>): React.JSX.Element {
  return (
    <M.Portal>
      <M.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-44 overflow-hidden rounded-lg border border-border-subtle bg-surface-overlay p-1 shadow-md',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          className,
        )}
        {...props}
      />
    </M.Portal>
  );
}

export function DropdownMenuItem({
  className,
  tone = 'default',
  ...props
}: React.ComponentProps<typeof M.Item> & { tone?: 'default' | 'danger' }): React.JSX.Element {
  return (
    <M.Item
      data-slot="dropdown-menu-item"
      className={cn(
        'relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none',
        'focus:bg-surface-sunken data-[disabled]:pointer-events-none data-[disabled]:text-ink-subtle',
        "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:text-ink-subtle",
        tone === 'danger' && 'text-danger-ink focus:bg-danger-soft [&_svg]:text-danger',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof M.Label>): React.JSX.Element {
  return (
    <M.Label
      className={cn('px-2 py-1.5 text-xs font-medium text-ink-subtle', className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof M.Separator>): React.JSX.Element {
  return <M.Separator className={cn('-mx-1 my-1 h-px bg-border-subtle', className)} {...props} />;
}

export function DropdownMenuRadioGroup(
  props: React.ComponentProps<typeof M.RadioGroup>,
): React.JSX.Element {
  return <M.RadioGroup {...props} />;
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof M.RadioItem>): React.JSX.Element {
  return (
    <M.RadioItem
      className={cn(
        'relative flex cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 pl-7 text-sm outline-none select-none',
        'focus:bg-surface-sunken',
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 flex size-3.5 items-center justify-center">
        <M.ItemIndicator>
          <span className="size-1.5 rounded-full bg-brand" />
        </M.ItemIndicator>
      </span>
      {children}
    </M.RadioItem>
  );
}
