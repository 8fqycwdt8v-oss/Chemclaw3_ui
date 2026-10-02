/**
 * What an `exhibit` frame does when it arrives.
 *
 * Two arrival paths, two different meanings, one module so the difference is stated once:
 *
 *  - **On the turn stream** (`exhibitArrived`) the frame is part of the answer to a question this
 *    reader asked: the agent wrote or revised an artefact. The session's list is refetched, and a
 *    *created* artefact opens the pane unless the reader closed it this turn (the rule lives on
 *    `useExhibitPane.autoOpen`) — and only if that conversation is the one on screen.
 *  - **On the push-back stream** (`exhibitPushed`) it is somebody else's act — a colleague's edit or
 *    pin in a shared session, or this reader's own from another tab. The list is refetched and
 *    nothing opens: a column of the screen is not something a colleague's save gets to take.
 *
 * The frame is a header and nothing renders from it directly (`shared/events.ts`), so what both
 * paths share is an invalidation — and it is `invalidateQueries` on the session's *prefix*, which
 * reaches the list, the head body and the history under it in one call (`keys.exhibit`).
 */

import { keys, queryClient } from '../api/queryClient.ts';
import type { ExhibitEvent } from '../../shared/events.ts';
import { useExhibitPane } from './exhibitPane.ts';
import { useChatStore } from './chatStore.ts';

function refetch(sessionId: string): void {
  void queryClient.invalidateQueries({ queryKey: keys.exhibits(sessionId) });
  // The cross-session page lists this one too; it is cheap to mark and only refetches if open.
  void queryClient.invalidateQueries({ queryKey: keys.myExhibits });
}

/** Whether `sessionId` is the session of the conversation on screen (`activeId` follows the URL). */
function onScreen(sessionId: string): boolean {
  const { activeId, conversations } = useChatStore.getState();
  return activeId !== null && conversations[activeId]?.sessionId === sessionId;
}

export function exhibitArrived(sessionId: string, event: ExhibitEvent): void {
  refetch(sessionId);
  if (event.op !== 'created' || !event.exhibit_id) return;
  // Only where the reader is looking. A turn keeps running after its reader switches conversation,
  // and opening the column then would put the *other* conversation's artefact rule into this one's
  // screen — the pane shows this session's list, so it would open on something unrelated to the
  // artefact that caused it. Off screen, the new artefact is put in front for when they come back.
  if (onScreen(sessionId)) useExhibitPane.getState().autoOpen(sessionId, event.exhibit_id);
  else useExhibitPane.getState().focusOnly(sessionId, event.exhibit_id);
}

export function exhibitPushed(sessionId: string): void {
  refetch(sessionId);
}
