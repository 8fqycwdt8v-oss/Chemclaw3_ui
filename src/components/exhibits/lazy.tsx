/**
 * The two artefact surfaces that live *inside other components* — the card in an answer and the
 * "Pin as artefact" control on a result — loaded with the first one that is needed, not with the
 * app.
 *
 * Both were static imports of `MessageList` and `ResultBlock`, which are on the first load, so every
 * chemist downloaded them, their icons and their query wiring before the shell painted — measured,
 * the artefact feature cost the first load 8 kB gzip and left `check:bundle` 1.8 kB of headroom.
 * Neither can be on screen before an answer has arrived, and by then this chunk has had the whole
 * turn to load.
 *
 * **The fallbacks are chosen so the swap moves nothing.** The card's is a box of the card's own
 * height and margins, so the answer below it does not jump when the chunk lands. The pin's is
 * nothing: it sits in a footer row whose height the other controls set, before an `ml-auto` byte
 * count, so its arrival widens the row's free space and shifts no line.
 */

import { lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';
import type { ExhibitCard as Card } from './ExhibitCard.tsx';
import type { PinResult as Pin } from './PinResult.tsx';

const CardChunk = lazy(() => import('./ExhibitCard.tsx').then((m) => ({ default: m.ExhibitCard })));
const PinChunk = lazy(() => import('./PinResult.tsx').then((m) => ({ default: m.PinResult })));

/** The card's footprint while its chunk loads: the same margin, border and height as the card. */
function CardPlaceholder(): React.JSX.Element {
  return (
    <div
      aria-hidden
      className="my-2 h-[3.125rem] max-w-prose rounded-xl border border-border-subtle bg-surface-raised"
    />
  );
}

export function LazyExhibitCard(props: ComponentProps<typeof Card>): React.JSX.Element {
  return (
    <Suspense fallback={<CardPlaceholder />}>
      <CardChunk {...props} />
    </Suspense>
  );
}

export function LazyPinResult(props: ComponentProps<typeof Pin>): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <PinChunk {...props} />
    </Suspense>
  );
}
