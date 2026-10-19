/**
 * Reading preferences that belong to the chemist, not a conversation; currently whether answer
 * structures are drawn automatically.
 *
 * Global, not per conversation: a chemist's preference does not change between threads. RDKit still
 * gates every drawing. Kept out of `chatStore` (versioned, migrated); a bare key written like
 * `themeStore`'s falls back to the default when missing or unreadable.
 */

import { create } from 'zustand';

const STORAGE_KEY = 'chemclaw3.draw-structures';

const read = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on';
  } catch {
    // Private mode, or storage denied. Non-persistent is still usable for this session.
    return false;
  }
};

interface PrefsState {
  /**
   * Draw every structure an answer names without being asked. Off by default: an unrequested
   * affordance should be a button, not a picture.
   */
  drawStructures: boolean;
  setDrawStructures: (on: boolean) => void;
}

export const usePrefsStore = create<PrefsState>()((set) => ({
  drawStructures: read(),

  setDrawStructures(on) {
    try {
      if (on) localStorage.setItem(STORAGE_KEY, 'on');
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // As above: the session still gets the setting, it just does not outlive the tab.
    }
    set({ drawStructures: on });
  },
}));
