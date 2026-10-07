/**
 * The artefact pane's state: open, what it shows, width. Bodies live in React Query
 * (`keys.exhibits`, `keys.exhibit`); this holds only the reader's choices.
 *
 * Width is per account (`oid`-partitioned key, re-pointed by `hydrateExhibitPaneForAccount`); only
 * the width is persisted.
 *
 * Auto-open: an artefact the agent creates during a turn opens the pane, unless the reader closed
 * it during that turn. `turnStarted` re-arms; `close` disarms.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { MAX_EXHIBIT_REFS, type ExhibitRef } from '../../shared/exhibitConstants.ts';

/**
 * The column's bounds in CSS pixels, leaving the transcript its reading measure; published as
 * `aria-valuemin`/`aria-valuemax`.
 */
export const PANE_MIN_PX = 300;
export const PANE_MAX_PX = 760;
export const PANE_DEFAULT_PX = 420;
/** One arrow-key press. Shift+arrow moves four of these, the common "large step" convention. */
export const PANE_STEP_PX = 16;

export const clampWidth = (px: number): number =>
  Math.round(Math.min(PANE_MAX_PX, Math.max(PANE_MIN_PX, Number.isFinite(px) ? px : 0)));

/** Which half of the right column is showing. */
export type PaneTab = 'artefacts' | 'index';

interface ExhibitPaneState {
  /** Whether the column is showing the pane, at `lg` and wider. */
  open: boolean;
  /**
   * Whether the sheet shows it below `lg`. Separate so auto-open never slides a sheet over a phone
   * screen; a deliberate Open sets both.
   */
  sheetOpen: boolean;
  tab: PaneTab;
  /**
   * The artefact in front per session, and the revision picked on it (`0` is the head), so neither
   * leaks across sessions or artefacts (`revisionShown`).
   */
  focus: Record<string, PaneFocus>;
  /** Set by a close and cleared at the start of a turn — see the module docstring. */
  dismissedThisTurn: boolean;
  /** Persisted, per account. */
  widthPx: number;
  /** Artefacts to attach to the next message, per conversation (`exhibit_refs`). Not persisted. */
  refs: Record<string, ExhibitRef[]>;

  /** Open the pane on one artefact — a card's Open, a "My artefacts" row. Never auto. */
  show: (sessionId: string, exhibitId: string, revision?: number) => void;
  /**
   * Open the pane where it was; a session with no focus is pinned to `fallback` so reordering
   * cannot swap the document.
   */
  reveal: (sessionId: string, fallback: string) => void;
  /** The reader closed it. Disarms the auto-open until the next turn. */
  close: () => void;
  setTab: (tab: PaneTab) => void;
  /** Show `revision` of one artefact in one session (`0` is the head). */
  setRevision: (sessionId: string, exhibitId: string, revision: number) => void;
  /**
   * Make `exhibitId` the focus unless it already is, so a fallback becomes a choice that list
   * reordering cannot change.
   */
  pin: (sessionId: string, exhibitId: string) => void;
  setWidth: (px: number) => void;
  /** A turn began: the auto-open is re-armed. */
  turnStarted: () => void;
  /**
   * The agent created an artefact: open on it unless closed this turn. Returns whether it opened.
   */
  autoOpen: (sessionId: string, exhibitId: string) => boolean;
  /**
   * The agent began drafting a document: open the column under the same rule (no focus to set yet).
   * Returns whether it opened.
   */
  openForDraft: () => boolean;
  /** Put `exhibitId` in front for `sessionId` without opening anything — a turn's new artefact in
   *  a conversation that is not on screen, waiting for the reader to come back to it. */
  focusOnly: (sessionId: string, exhibitId: string) => void;
  /** Add an artefact chip to a conversation's composer. False when it is already there or full. */
  addRef: (conversationId: string, ref: ExhibitRef) => boolean;
  removeRef: (conversationId: string, exhibitId: string) => void;
  /** A refused message's chips, put back — only where none have been attached since. */
  restoreRefs: (conversationId: string, refs: readonly ExhibitRef[]) => void;
  /** The chips went out with a message; the composer starts clean. */
  clearRefs: (conversationId: string) => void;
}

/** What the pane holds in front for one session. */
export interface PaneFocus {
  exhibitId: string;
  /** `0` is the head. */
  revision: number;
}

/** The artefact in front for a session, or `null` when nothing was chosen there yet. */
export const focusOf = (s: Pick<ExhibitPaneState, 'focus'>, sessionId: string): PaneFocus | null =>
  s.focus[sessionId] ?? null;

/** The revision to show of `exhibitId`: the one picked on that artefact, or the head. */
export const revisionShown = (
  s: Pick<ExhibitPaneState, 'focus'>,
  sessionId: string,
  exhibitId: string,
): number => {
  const f = focusOf(s, sessionId);
  return f && f.exhibitId === exhibitId ? f.revision : 0;
};

const NO_REFS: ExhibitRef[] = [];

/** The refs waiting in one conversation's composer — a stable empty array when there are none, so
 *  a selector that reads it does not mint a new snapshot on every render. */
export const refsOf = (s: Pick<ExhibitPaneState, 'refs'>, conversationId: string): ExhibitRef[] =>
  s.refs[conversationId] ?? NO_REFS;

/** The base of the persisted key; the account's `oid` is appended. */
export const PANE_STORAGE_BASE = 'chemclaw3.exhibit-pane.v1';

export const paneStorageKey = (oid: string | null | undefined): string =>
  `${PANE_STORAGE_BASE}.${oid ?? 'anon'}`;

/**
 * `localStorage` with every failure swallowed: this store writes at every turn start, and a storage
 * error must not break sending.
 */
const storage = createJSONStorage<{ widthPx: number }>(() => ({
  getItem(name) {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem(name, value) {
    try {
      localStorage.setItem(name, value);
    } catch {
      // Unremembered, not broken.
    }
  },
  removeItem(name) {
    try {
      localStorage.removeItem(name);
    } catch {
      // As above.
    }
  },
}));

export const useExhibitPane = create<ExhibitPaneState>()(
  persist(
    (set, get) => ({
      open: false,
      sheetOpen: false,
      tab: 'artefacts',
      focus: {},
      dismissedThisTurn: false,
      widthPx: PANE_DEFAULT_PX,
      refs: {},

      show(sessionId, exhibitId, revision = 0) {
        set((s) => ({
          open: true,
          sheetOpen: true,
          tab: 'artefacts',
          focus: { ...s.focus, [sessionId]: { exhibitId, revision } },
        }));
      },
      reveal(sessionId, fallback) {
        set((s) => ({
          open: true,
          sheetOpen: true,
          focus: s.focus[sessionId]
            ? s.focus
            : { ...s.focus, [sessionId]: { exhibitId: fallback, revision: 0 } },
        }));
      },
      close() {
        set({ open: false, sheetOpen: false, dismissedThisTurn: true });
      },
      setTab(tab) {
        set({ tab });
      },
      setRevision(sessionId, exhibitId, revision) {
        set((s) => ({
          focus: {
            ...s.focus,
            [sessionId]: { exhibitId, revision: Math.max(0, Math.trunc(revision)) },
          },
        }));
      },
      pin(sessionId, exhibitId) {
        if (get().focus[sessionId]?.exhibitId === exhibitId) return;
        set((s) => ({ focus: { ...s.focus, [sessionId]: { exhibitId, revision: 0 } } }));
      },
      focusOnly(sessionId, exhibitId) {
        set((s) => ({ focus: { ...s.focus, [sessionId]: { exhibitId, revision: 0 } } }));
      },
      setWidth(px) {
        set({ widthPx: clampWidth(px) });
      },
      turnStarted() {
        set({ dismissedThisTurn: false });
      },
      autoOpen(sessionId, exhibitId) {
        if (get().dismissedThisTurn) return false;
        // The column only — see `sheetOpen`.
        set((s) => ({
          open: true,
          tab: 'artefacts',
          focus: { ...s.focus, [sessionId]: { exhibitId, revision: 0 } },
        }));
        return true;
      },
      openForDraft() {
        if (get().dismissedThisTurn) return false;
        set({ open: true, tab: 'artefacts' });
        return true;
      },
      addRef(conversationId, ref) {
        const current = refsOf(get(), conversationId);
        if (current.length >= MAX_EXHIBIT_REFS) return false;
        if (current.some((r) => r.exhibit_id === ref.exhibit_id)) return false;
        set((s) => ({ refs: { ...s.refs, [conversationId]: [...current, ref] } }));
        return true;
      },
      removeRef(conversationId, exhibitId) {
        set((s) => ({
          refs: {
            ...s.refs,
            [conversationId]: refsOf(s, conversationId).filter((r) => r.exhibit_id !== exhibitId),
          },
        }));
      },
      restoreRefs(conversationId, refs) {
        if (refsOf(get(), conversationId).length > 0 || refs.length === 0) return;
        set((s) => ({ refs: { ...s.refs, [conversationId]: [...refs] } }));
      },
      clearRefs(conversationId) {
        set((s) => {
          const next = { ...s.refs };
          delete next[conversationId];
          return { refs: next };
        });
      },
    }),
    {
      name: paneStorageKey(null),
      version: 1,
      storage,
      // The width alone — see the module docstring for why nothing else outlives the page.
      partialize: (s) => ({ widthPx: s.widthPx }),
      // A stored width from an older bound, or hand-edited, is clamped rather than trusted.
      merge: (persisted, current) => {
        const stored = (persisted as { widthPx?: unknown } | undefined)?.widthPx;
        return typeof stored === 'number' && Number.isFinite(stored)
          ? { ...current, widthPx: clampWidth(stored) }
          : current;
      },
      // Not before the account is known — `chatStore`'s reason, one store over.
      skipHydration: true,
    },
  ),
);

let hydratedName: string | null = null;

/** Point the persisted width at this account's slot and read it, once per account. */
export function hydrateExhibitPaneForAccount(oid: string | null | undefined): void {
  const name = paneStorageKey(oid);
  if (hydratedName === name) return;
  hydratedName = name;
  useExhibitPane.persist.setOptions({ name });
  void useExhibitPane.persist.rehydrate();
}
