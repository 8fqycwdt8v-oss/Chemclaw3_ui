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
 * A third frame, `exhibit_draft` (wave 2), arrives on the turn stream only, before the `exhibit`
 * frame it turns into: `draftArrived` holds it in `exhibitDrafts.ts` and `exhibitArrived` settles it.
 *
 * The frame is a header and nothing renders from it directly (`shared/events.ts`), so what both
 * paths share is an invalidation — and it is `invalidateQueries` on the session's *prefix*, which
 * reaches the list, the head body and the history under it in one call (`keys.exhibit`).
 */

import { keys, queryClient } from '../api/queryClient.ts';
import type { ExhibitDraftEvent, ExhibitEvent, ToolFailedEvent } from '../../shared/events.ts';
import { useExhibitPane } from './exhibitPane.ts';
import { useChatStore } from './chatStore.ts';
import {
  applyDraft,
  discardUnsettled,
  dropDraft,
  failDraft,
  settleDraft,
} from './exhibitDrafts.ts';

/** Refetch the session's list; resolves once it has answered (or failed — either way, settled). */
function refetch(sessionId: string): Promise<void> {
  // The cross-session page lists this one too; it is cheap to mark and only refetches if open.
  void queryClient.invalidateQueries({ queryKey: keys.myExhibits });
  return queryClient.invalidateQueries({ queryKey: keys.exhibits(sessionId) });
}

/** Whether `sessionId` is the session of the conversation on screen (`activeId` follows the URL). */
function onScreen(sessionId: string): boolean {
  const { activeId, conversations } = useChatStore.getState();
  return activeId !== null && conversations[activeId]?.sessionId === sessionId;
}

export function exhibitArrived(sessionId: string, event: ExhibitEvent): void {
  const refreshed = refetch(sessionId);
  // The draft this frame replaces, if one was streaming: kept on screen until the list can show
  // the artefact in its place, then dropped — so the swap has no empty frame between the two.
  const settled = event.exhibit_id ? settleDraft(sessionId, event) : null;
  if (settled !== null) void refreshed.finally(() => dropDraft(sessionId, settled));
  if (event.op !== 'created' || !event.exhibit_id) return;
  // Only where the reader is looking. A turn keeps running after its reader switches conversation,
  // and opening the column then would put the *other* conversation's artefact rule into this one's
  // screen — the pane shows this session's list, so it would open on something unrelated to the
  // artefact that caused it. Off screen, the new artefact is put in front for when they come back.
  if (onScreen(sessionId)) useExhibitPane.getState().autoOpen(sessionId, event.exhibit_id);
  else useExhibitPane.getState().focusOnly(sessionId, event.exhibit_id);
}

export function exhibitPushed(sessionId: string): void {
  void refetch(sessionId);
}

/**
 * An `exhibit_draft` frame on the turn stream (wave 2): a document the agent is still writing.
 *
 * The first frame of a *create* opens the pane by the same rule as the `exhibit` frame it precedes
 * — the column only, only for the conversation on screen, and not if the reader closed the pane
 * this turn — so a long report is watched being written where it will land rather than appearing
 * after a silent minute. A revise opens nothing: it draws over the artefact only if the reader is
 * already looking at it.
 */
export function draftArrived(sessionId: string, event: ExhibitDraftEvent): void {
  const began = applyDraft(sessionId, event);
  if (began && onScreen(sessionId)) useExhibitPane.getState().openForDraft();
}

/** The two tools whose calls stream drafts, and the draft op each one's call is. */
const DRAFTING_TOOLS: Readonly<Record<string, 'create' | 'revise'>> = {
  create_exhibit: 'create',
  revise_exhibit: 'revise',
};

/** A tool call raised on the turn stream: if it was one that drafts, its draft is discarded now. */
export function draftToolFailed(sessionId: string, event: ToolFailedEvent): void {
  const op = DRAFTING_TOOLS[event.tool];
  if (op) failDraft(sessionId, op);
}

/** The turn is over: a draft that never became an artefact is discarded. */
export function draftsEnded(sessionId: string): void {
  discardUnsettled(sessionId);
}
