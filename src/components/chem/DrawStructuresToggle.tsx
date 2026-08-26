/**
 * "Draw structures in answers" — one switch, in place of one click per molecule.
 *
 * `InlineSmiles` used to hold its own `useState(false)`, so an answer naming six compounds was six
 * clicks, and re-parsing the markdown or reloading the page reset every one of them. The chemist
 * was being asked the same question again and again, and the answer never changed.
 *
 * The opt-in *discipline* is untouched and still matters: RDKit gates the affordance, so nothing is
 * ever drawn from a string the recogniser merely guessed at, whichever way this is set. This
 * decides only whether a confirmed structure waits to be asked for.
 *
 * It lives in the top bar rather than in the entity rail, which was the other candidate. The rail
 * does not exist on a fresh conversation, and a preference that can only be found once the app has
 * something to say is a preference most people never find.
 */

import { Hexagon } from 'lucide-react';
import { usePrefsStore } from '@/state/prefsStore';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export function DrawStructuresToggle(): React.JSX.Element {
  const on = usePrefsStore((s) => s.drawStructures);
  const set = usePrefsStore((s) => s.setDrawStructures);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          // A pressed toggle, not a menu: there are two states and both are visible from the
          // control, so `aria-pressed` says everything a label would.
          aria-pressed={on}
          aria-label={on ? 'Structures are drawn in answers' : 'Draw structures in answers'}
          className={cn(on && 'bg-brand-soft text-brand-ink')}
          onClick={() => set(!on)}
        >
          <Hexagon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {on
          ? 'Structures are drawn in answers — click to go back to showing them on request'
          : 'Draw structures in answers, instead of offering each one a button'}
      </TooltipContent>
    </Tooltip>
  );
}
