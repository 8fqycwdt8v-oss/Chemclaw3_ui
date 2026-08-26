/**
 * "Put this structure in my message."
 *
 * The one control that turns a drawing back into an input. Before it, every structure this app
 * rendered was terminal: the agent would answer "the SMILES for 4-bromoanisole is `COc1ccc(Br)cc1`",
 * the UI would draw it and RDKit would confirm it was a molecule — and the only way to ask a
 * follow-up about it was to select the text with a mouse.
 *
 * It is deliberately the *same* control everywhere it appears — inline in an answer, on a rail row,
 * on a search hit, on a note's compound. A chemist should not have to learn that a structure in one
 * place is reusable and a structure in another is a picture.
 *
 * ## It composes a message and stops there
 *
 * No tool is called and nothing is sent. `insertStructure` puts the string at the caret and leaves
 * the draft alone, so "screen this for hazards" is still the chemist's sentence to write. A button
 * that ran a calculation would need the authorization story — `agent/authz.py`, the plan gate,
 * `expensive: true` — thought through first, and that is a larger question than a control.
 *
 * ## Only for a structure something has already vouched for
 *
 * Every call site hands over a string that has been through RDKit: a canonical rail key, a hit's
 * stored structure, an inline span the renderer confirmed before offering the affordance. This
 * component does not re-check, because a control that appeared and then refused would be worse
 * than one that never appeared — the checking belongs at the point where the affordance is decided.
 */

import { CornerUpLeft } from 'lucide-react';
import { insertStructure } from '../../state/composerEvents.ts';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function UseStructure({
  smiles,
  /** `label` shows the words beside the icon; the compact form is icon-only with the name in
   *  `aria-label`, for the rail row and the hit grid where a full button would crowd the drawing. */
  label = false,
  className,
  onUsed,
}: {
  smiles: string;
  label?: boolean;
  className?: string;
  /** Called after the event is dispatched — a sheet uses it to close itself, so the chemist is
   *  returned to the message they are now editing rather than left behind a panel. */
  onUsed?: () => void;
}): React.JSX.Element {
  return (
    <Button
      variant="outline"
      size={label ? 'xs' : 'icon-xs'}
      className={cn('tap-target', className)}
      aria-label={`Use ${smiles} in my message`}
      title={`Use ${smiles} in my message`}
      onClick={() => {
        insertStructure(smiles);
        onUsed?.();
      }}
    >
      <CornerUpLeft aria-hidden />
      {label && 'Use in my message'}
    </Button>
  );
}
