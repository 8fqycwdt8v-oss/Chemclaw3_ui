/**
 * Guard for a panel whose subject can change while a read is in flight: only the newest request may
 * set state, so a slow earlier answer cannot render under the current heading
 * (`tests/staleSheetResponse.test.tsx`).
 *
 * A sequence number, not an id comparison, because the same id can be read twice (`JobsPanel`
 * re-reads a job it just cancelled). Deliberately not a data-fetching hook; callers keep their own
 * state shapes.
 */

import { useCallback, useRef } from 'react';

/**
 * Returns `claim()`: call it when a read starts, and it hands back `isNewest()` — true until a
 * later read of the same panel claims it. Every `setState` on the response path goes behind it.
 */
export function useNewestRead(): () => () => boolean {
  const issued = useRef(0);
  return useCallback(() => {
    const mine = ++issued.current;
    return () => issued.current === mine;
  }, []);
}
