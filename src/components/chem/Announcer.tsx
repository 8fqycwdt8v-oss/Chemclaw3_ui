/**
 * The app's single polite live region.
 *
 * The hard part of announcing a streaming answer is that you must not announce the answer.
 * Putting `aria-live` on text that mutates once per animation frame makes NVDA and JAWS queue
 * every mutation and stutter through the whole answer from the top, repeatedly — considerably
 * worse than silence, which is what the app offered before.
 *
 * So the streaming container carries `aria-busy` and no live region, and this announces
 * TRANSITIONS only: one short sentence when the turn changes state. The reader learns that an
 * answer started, that it finished and roughly how long it is, and can then navigate to it
 * deliberately — rather than having focus yanked mid-sentence.
 *
 * Assertive messages (a failed turn, a degraded capability) go through `role="alert"` at their own
 * call sites, because they must interrupt.
 */

import { useEffect, useRef, useState } from 'react';

let announce: ((message: string) => void) | null = null;

/**
 * Announce a state transition politely. Safe to call from outside React — the turn orchestrator
 * lives outside the tree and is the main caller.
 */
export function announceStatus(message: string): void {
  announce?.(message);
}

export function Announcer(): React.JSX.Element {
  const [message, setMessage] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    announce = (next: string) => {
      // Clearing first forces a re-announcement when the same sentence arrives twice in a row;
      // a live region whose text does not change says nothing at all.
      setMessage('');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setMessage(next), 60);
    };
    return () => {
      announce = null;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only-live">
      {message}
    </div>
  );
}
