/**
 * The app's single polite live region.
 *
 * The hard part of announcing a streaming answer is that you must not announce the answer. Putting
 * `aria-live` on text that mutates once per animation frame makes NVDA and JAWS queue every
 * mutation and stutter through the whole answer from the top, repeatedly — considerably worse than
 * silence, which is what the app offered before.
 *
 * So the streaming container carries `aria-busy` and no live region, and this announces
 * TRANSITIONS only, one short sentence each. The reader learns that an answer started, that it
 * finished and roughly how long it is, and can then navigate to it deliberately — rather than
 * having focus yanked mid-sentence.
 *
 * The messages come from `state/announce.ts`, which the turn orchestrator writes to. This component
 * is only the mouth.
 */

import { useEffect, useRef, useState } from 'react';
import { registerAnnouncer } from '@/state/announce';

export function Announcer(): React.JSX.Element {
  const [message, setMessage] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const dispose = registerAnnouncer((next) => {
      // Clearing first forces a re-announcement when the same sentence arrives twice in a row; a
      // live region whose text does not change says nothing at all.
      setMessage('');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setMessage(next), 60);
    });
    return () => {
      dispose();
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only-live">
      {message}
    </div>
  );
}
