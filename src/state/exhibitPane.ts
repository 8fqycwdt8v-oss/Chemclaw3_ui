/**
 * The artefact pane's state: whether it is open, what it shows, how wide it is.
 *
 * **Bodies are not here.** React Query is the source of truth for every artefact body and list
 * (`keys.exhibits`, `keys.exhibit`), keyed by session; this store holds only what is the *reader's*
 * — a column they opened or closed, a revision they picked, a width they dragged. Putting a body
 * here as well would be a second copy of a document two people can edit, and the copy that went
 * stale would be the one on screen.
 *
 * ## Width is the reader's, not the conversation's, and it is per account
 *
 * The concept's own words: persisted "per user rather than per conversation". A chemist who wants a
 * wide pane wants it wide; asking again in every thread is the per-token failure `prefsStore`
 * records at a coarser grain. Per *account* rather than per browser for `chatStore`'s reason — a
 * shared analytical-development workstation has more than one chemist at it — so the persisted key
 * is partitioned by `oid` the same way, and `hydrateExhibitPaneForAccount` re-points it once the
 * account is known. Only the width is persisted: an open pane or a picked revision restored into a
 * conversation it was not picked in would be a state nobody chose.
 *
 * ## The auto-open rule
 *
 * An artefact the agent *creates* during a turn opens the pane on it — it is part of the answer,
 * and an answer whose main exhibit is behind a button is half an answer. **Unless the reader closed
 * the pane during this turn**: Claude's own behaviour, and the right one — a reader who dismissed
 * the column mid-answer has said where they want to look, and taking it back on the next frame
 * would be the app overruling them. `turnStarted` re-arms it, so the next question gets the
 * ordinary behaviour; `close` is the only thing that disarms it.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { MAX_EXHIBIT_REFS, type ExhibitRef } from '../../shared/exhibits.ts';

/**
 * The column's bounds, in CSS pixels.
 *
 * The minimum is where a table of three columns with units still reads; the maximum leaves the
 * transcript its reading measure (`max-w-prose` is 65ch ≈ 600px) beside the 256px sidebar on a
 * 1440px screen. The resizer clamps to both, and `aria-valuemin`/`aria-valuemax` publish them.
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
   * Whether the sheet is showing it, below `lg`. A second flag rather than the same one, because
   * the auto-open must not reach it: a column opening beside the transcript is the answer's
   * exhibit appearing where exhibits go, while a modal sheet sliding over a phone's whole screen
   * mid-answer is the app taking the screen away. A deliberate Open sets both.
   */
  sheetOpen: boolean;
  tab: PaneTab;
  /**
   * The artefact in front, *with the session it belongs to*. A focus from another conversation is
   * ignored by the pane rather than cleared, so switching away mid-turn and back keeps it.
   */
  focus: { sessionId: string; exhibitId: string } | null;
  /** The revision on screen; `0` is the head. Reset on every change of focus. */
  revision: number;
  /** Set by a close and cleared at the start of a turn — see the module docstring. */
  dismissedThisTurn: boolean;
  /** Persisted, per account. */
  widthPx: number;
  /**
   * Artefacts the reader has asked about, per conversation, waiting to ride the next message as
   * `exhibit_refs` (phase 2). Not persisted: a chip is part of a message being written, and the
   * draft it belongs to is what persistence keeps.
   */
  refs: Record<string, ExhibitRef[]>;

  /** Open the pane on one artefact — a card's Open, a "My artefacts" row. Never auto. */
  show: (sessionId: string, exhibitId: string, revision?: number) => void;
  /** Open the pane where it was. The top bar's toggle and the sheet trigger. */
  reveal: () => void;
  /** The reader closed it. Disarms the auto-open until the next turn. */
  close: () => void;
  setTab: (tab: PaneTab) => void;
  setRevision: (revision: number) => void;
  setWidth: (px: number) => void;
  /** A turn began: the auto-open is re-armed. */
  turnStarted: () => void;
  /**
   * The agent created an artefact during a turn. Opens the pane on it unless the reader closed the
   * pane this turn. Returns whether it opened, for the test that holds the rule.
   */
  autoOpen: (sessionId: string, exhibitId: string) => boolean;
  /** Add an artefact chip to a conversation's composer. False when it is already there or full. */
  addRef: (conversationId: string, ref: ExhibitRef) => boolean;
  removeRef: (conversationId: string, exhibitId: string) => void;
  /** The chips went out with a message; the composer starts clean. */
  clearRefs: (conversationId: string) => void;
}

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
 * `localStorage`, with every failure swallowed — read, write and remove alike.
 *
 * `persist` writes on *every* `set`, whatever `partialize` keeps, and this store is set at the start
 * of every turn (`turnStarted`). So a full quota or a denied storage throwing out of `setItem` was
 * not "the width is not remembered" — it was an exception out of `sendMessage`'s setup, which
 * `tests/persistQuota.test.ts` catches as a turn that raised a banner instead of running. The width
 * is the one thing at stake here, and losing it is the whole of the acceptable cost: the same
 * posture `prefsStore` and `themeStore` take for their own keys.
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
      focus: null,
      revision: 0,
      dismissedThisTurn: false,
      widthPx: PANE_DEFAULT_PX,
      refs: {},

      show(sessionId, exhibitId, revision = 0) {
        set({
          open: true,
          sheetOpen: true,
          tab: 'artefacts',
          focus: { sessionId, exhibitId },
          revision,
        });
      },
      reveal() {
        set({ open: true, sheetOpen: true });
      },
      close() {
        set({ open: false, sheetOpen: false, dismissedThisTurn: true });
      },
      setTab(tab) {
        set({ tab });
      },
      setRevision(revision) {
        set({ revision: Math.max(0, Math.trunc(revision)) });
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
        set({ open: true, tab: 'artefacts', focus: { sessionId, exhibitId }, revision: 0 });
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

/**
 * Point the persisted width at this account's own slot and read it. Once per account: a second
 * `rehydrate()` would replace a width dragged since with the stored one.
 */
export function hydrateExhibitPaneForAccount(oid: string | null | undefined): void {
  const name = paneStorageKey(oid);
  if (hydratedName === name) return;
  hydratedName = name;
  useExhibitPane.persist.setOptions({ name });
  void useExhibitPane.persist.rehydrate();
}
