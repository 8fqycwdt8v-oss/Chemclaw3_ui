/**
 * Documents the agent is still writing — the `exhibit_draft` frames of the turns in flight.
 *
 * **A draft is not an artefact**, and this store exists so the two never share a home. Artefacts
 * are React Query's (`keys.exhibits`), fetched from the service and versioned there; a draft is a
 * few seconds of one turn's stream, never persisted upstream and not persisted here either. Putting
 * it in the query cache as a pretend revision would leave a body on screen that no `GET` could ever
 * return, and putting it in `chatStore` would write it to `localStorage` on every frame.
 *
 * ## The lifecycle, which is the contract's
 *
 *  1. **Arrives** — `exhibit_draft` frames, each carrying the whole text so far, keyed by the
 *     provider's `call_id`. A later frame replaces an earlier one; a frame whose text is no longer
 *     than what is held (a reordered or repeated frame) is ignored, so the text on screen only grows.
 *  2. **Settles** — the turn's `exhibit` frame names the artefact the call became: the *first*
 *     unsettled create draft for a `created` frame (a create carries no id until the tool runs, and
 *     the service emits the `exhibit` frames in call order), the revise draft naming the same
 *     `exhibit_id` for a `revised` one. A settled draft stays on screen until the session's list has
 *     been refetched, so the swap from draft to artefact has nothing in between to flash.
 *  3. **Is dropped** — once settled and refetched; or, unsettled, when the turn ends: the tool was
 *     refused or the turn failed, and the text the reader watched being written is not a document
 *     anybody has.
 */

import { create } from 'zustand';
import type { ExhibitDraftEvent } from '../../shared/events.ts';

export interface ExhibitDraft {
  /** The provider's tool-call id, or a stand-in when the service sent none. */
  callId: string;
  op: 'create' | 'revise';
  /** Empty for a create until it settles; the artefact being revised for a revise. */
  exhibitId: string;
  title: string;
  markdown: string;
  /** The artefact this draft became, once its `exhibit` frame arrived; `null` while drafting. */
  settledAs: string | null;
}

interface DraftState {
  /** Per session, in arrival order — the order the matching rule depends on. */
  drafts: Record<string, ExhibitDraft[]>;
}

export const useExhibitDrafts = create<DraftState>()(() => ({ drafts: {} }));

const NONE: ExhibitDraft[] = [];

/** One session's drafts — a stable empty array when there are none, for selector equality. */
export const draftsOf = (s: DraftState, sessionId: string): ExhibitDraft[] =>
  s.drafts[sessionId] ?? NONE;

/** The create draft the pane shows for a session: the earliest one still in front of its artefact. */
export const createDraftOf = (s: DraftState, sessionId: string): ExhibitDraft | null =>
  draftsOf(s, sessionId).find((d) => d.op === 'create') ?? null;

/** The revise draft over one artefact, if the agent is rewriting it right now. */
export const reviseDraftOf = (
  s: DraftState,
  sessionId: string,
  exhibitId: string,
): ExhibitDraft | null =>
  draftsOf(s, sessionId).find((d) => d.op === 'revise' && d.exhibitId === exhibitId) ?? null;

const update = (sessionId: string, next: (drafts: ExhibitDraft[]) => ExhibitDraft[]): void => {
  useExhibitDrafts.setState((s) => {
    const drafts = next(draftsOf(s, sessionId));
    const all = { ...s.drafts };
    if (drafts.length > 0) all[sessionId] = drafts;
    else delete all[sessionId];
    return { drafts: all };
  });
};

/**
 * Take one frame. Returns whether it *began* a create draft — the moment the pane may open.
 *
 * A frame for a kind other than `document` is ignored: the contract streams documents only, and a
 * draft of anything else would be text this surface does not know how to show as what it will be.
 * An empty kind is kept — the partial spec may not have reached its `kind` key yet.
 */
export function applyDraft(sessionId: string, event: ExhibitDraftEvent): boolean {
  if (event.kind !== '' && event.kind !== 'document') return false;
  const callId = event.call_id || `${event.op}:${event.exhibit_id}`;
  let began = false;
  update(sessionId, (drafts) => {
    const held = drafts.find((d) => d.callId === callId);
    if (held) {
      if (held.settledAs !== null || event.markdown.length <= held.markdown.length) return drafts;
      return drafts.map((d) =>
        d === held ? { ...d, markdown: event.markdown, title: event.title || d.title } : d,
      );
    }
    began = event.op === 'create';
    return [
      ...drafts,
      {
        callId,
        op: event.op,
        exhibitId: event.exhibit_id,
        title: event.title,
        markdown: event.markdown,
        settledAs: null,
      },
    ];
  });
  return began;
}

/**
 * The turn's `exhibit` frame arrived: mark the draft it replaces. Returns that draft's call id, or
 * `null` when no draft was waiting for this frame (a table, or a revise that streamed nothing).
 */
export function settleDraft(
  sessionId: string,
  op: 'created' | 'revised',
  exhibitId: string,
): string | null {
  const waiting = draftsOf(useExhibitDrafts.getState(), sessionId).find(
    (d) =>
      d.settledAs === null &&
      (op === 'created' ? d.op === 'create' : d.op === 'revise' && d.exhibitId === exhibitId),
  );
  if (!waiting) return null;
  update(sessionId, (drafts) =>
    drafts.map((d) => (d === waiting ? { ...d, settledAs: exhibitId } : d)),
  );
  return waiting.callId;
}

/** A settled draft's artefact is in the list now: the draft has done its job. */
export function dropDraft(sessionId: string, callId: string): void {
  update(sessionId, (drafts) => drafts.filter((d) => d.callId !== callId));
}

/**
 * The turn ended. Every draft that never became an artefact is discarded; a settled one is left to
 * its refetch, which removes it once the artefact can be shown in its place.
 */
export function discardUnsettled(sessionId: string): void {
  update(sessionId, (drafts) => drafts.filter((d) => d.settledAs !== null));
}
