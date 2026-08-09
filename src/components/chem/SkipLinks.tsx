/**
 * Skip links.
 *
 * The first thing in the tab order, visible only once focused. Without them a keyboard user tabs
 * through every conversation in the sidebar before reaching the composer — which, on a surface
 * whose main verb is "type a message", is the whole interaction.
 */

import { cn } from '@/lib/utils';

const LINK = cn(
  'sr-only-live rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-fg shadow-md',
  'focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-100 focus:h-auto focus:w-auto',
  'focus:m-0 focus:overflow-visible focus:[clip-path:none] focus:whitespace-normal',
);

export function SkipLinks(): React.JSX.Element {
  return (
    <div className="absolute top-0 left-0 z-100">
      <a href="#transcript" className={LINK}>
        Skip to conversation
      </a>
      <a href="#composer" className={cn(LINK, 'focus:left-44')}>
        Skip to message box
      </a>
    </div>
  );
}
