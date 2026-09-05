/**
 * The guard a panel needs when the thing it is reading can change while the read is in flight.
 *
 * Two sheets in this app — the note panel and the job panel — fetch during
 * render behind a `loadedFor !== id` latch. The latch is right about what it is for: it resets the
 * panel to its loading state *synchronously*, so a re-target never paints the previous subject's
 * body under the new subject's heading for a frame. What it does not do is anything about the read
 * it just abandoned, which is still in flight and still holds a `setState` that will land whenever
 * the network gets round to it.
 *
 * So the last response to *arrive* won the panel, regardless of which one was asked for last, and
 * the heading and every action button stayed bound to the newest id. Measured on the note panel
 * (`tests/staleSheetResponse.test.tsx`): a panel headed `note-fast` rendering `note-slow`'s body,
 * source, author and validity window. That is not cosmetic on any of the three — a note panel is
 * the app's provenance surface, and the job panel offers Cancel on `status.status === 'running'`
 * while posting to `jobId`. Following a neighbour note is the designed way to walk the graph, so
 * the note case is reached by ordinary use rather than by a mistake. (A third sheet stood here —
 * the proposal panel, showing the bytes an Approve would commit — and went with the PR gate.)
 *
 * A sequence number rather than a comparison against the current id, because the same id read
 * twice is a real case — `JobsPanel` re-reads the job it has just asked to cancel — and an
 * id-equality guard would let the older of those two answers overwrite the newer one.
 *
 * Deliberately not a data-fetching hook. Each of the three panels encodes distinctions in its own
 * state that a generic `{status, data, error}` would flatten (the job panel's `failed` is separate
 * from its `notice` for a reason its own comment gives), and this bug is not a reason to rewrite
 * them.
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
