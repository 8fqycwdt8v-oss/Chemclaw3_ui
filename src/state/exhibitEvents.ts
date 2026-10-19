/**
 * What an `exhibit` frame does when it arrives.
 *
 * - **Turn stream** (`exhibitArrived`): the agent wrote or revised an artefact for this reader.
 *   Refetch the list; a created artefact opens the pane (per `useExhibitPane.autoOpen`) only for
 *   the conversation on screen.
 * - **Push-back stream** (`exhibitPushed`): someone else's act (colleague or another tab). Refetch
 *   only; nothing opens. `exhibit_draft` frames arrive on the turn stream first (`draftArrived`,
 *   held in `exhibitDrafts.ts`). Both paths invalidate the session prefix (`keys.exhibit`),
 *   covering list, head and history.
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
  // Keep the replaced draft on screen until the list can show the artefact, so the swap never
  // blanks.
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
 * An `exhibit_draft` frame: a document still being written. A create's first frame opens the pane
 * under the same rule as `exhibitArrived`; a revise opens nothing.
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
  if (op) failDraft(sessionId, op, event.call_id ?? '');
}

/** The turn is over: a draft that never became an artefact is discarded. */
export function draftsEnded(sessionId: string): void {
  discardUnsettled(sessionId);
}
