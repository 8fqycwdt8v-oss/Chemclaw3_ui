/**
 * Documents the agent is still writing: `exhibit_draft` frames of in-flight turns.
 *
 * A draft is not an artefact. Artefacts live in React Query (`keys.exhibits`); drafts live only
 * here, unpersisted. Lifecycle:
 * 1. **Arrives**: frames keyed by `call_id`, each carrying the whole text so far; a frame no longer
 * than what is held is ignored, so text only grows. 2. **Settles**: the turn's `exhibit` frame
 * names the artefact (`settleDraft`); a settled draft stays until the session list refetches, so
 * the swap does not flash. 3. **Is dropped**: once settled and refetched; at once when its call
 * raises (`failDraft`); or, unsettled, when the turn ends.
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
 * Take one frame; returns whether it began a create draft (when the pane may open). Only `document`
 * drafts are kept; an empty kind is kept because the partial spec may not have reached `kind` yet.
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
 * The turn's `exhibit` frame arrived: mark the draft it replaces and return its call id, or `null`
 * when none was waiting.
 *
 * Matches by `call_id` when present, so a retry or a concurrent table cannot settle the wrong
 * draft. An empty `call_id` (older service) falls back to: `created` documents settle the oldest
 * unsettled create draft; `revised` settles the revise draft naming the same artefact.
 */
export function settleDraft(
  sessionId: string,
  event: { op: 'created' | 'revised'; exhibit_id: string; kind: string; call_id?: string },
): string | null {
  const { op, exhibit_id: exhibitId } = event;
  const callId = event.call_id ?? '';
  const waiting = draftsOf(useExhibitDrafts.getState(), sessionId).find(
    (d) =>
      d.settledAs === null &&
      (callId
        ? d.callId === callId
        : op === 'created'
          ? d.op === 'create' && event.kind === 'document'
          : d.op === 'revise' && d.exhibitId === exhibitId),
  );
  if (!waiting) return null;
  update(sessionId, (drafts) =>
    drafts.map((d) => (d === waiting ? { ...d, settledAs: exhibitId } : d)),
  );
  return waiting.callId;
}

/**
 * A `create_exhibit`/`revise_exhibit` call raised (`tool_failed`): drop its draft now so it is not
 * mistaken for the retry's text.
 *
 * Matches by `call_id` when present; an empty id (older service) falls back to the oldest unsettled
 * draft of that op, since calls fail in order.
 */
export function failDraft(sessionId: string, op: 'create' | 'revise', callId = ''): void {
  const failed = draftsOf(useExhibitDrafts.getState(), sessionId).find(
    (d) => d.settledAs === null && (callId ? d.callId === callId : d.op === op),
  );
  if (failed) update(sessionId, (drafts) => drafts.filter((d) => d !== failed));
}

/** A settled draft's artefact is in the list now: the draft has done its job. */
export function dropDraft(sessionId: string, callId: string): void {
  update(sessionId, (drafts) => drafts.filter((d) => d.callId !== callId));
}

/** The turn ended: discard unsettled drafts; settled ones are removed by their refetch. */
export function discardUnsettled(sessionId: string): void {
  update(sessionId, (drafts) => drafts.filter((d) => d.settledAs !== null));
}
