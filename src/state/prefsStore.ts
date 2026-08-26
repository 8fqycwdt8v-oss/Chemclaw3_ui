/**
 * Reading preferences that are the chemist's, not the conversation's.
 *
 * One entry so far: whether structures in an answer are drawn without being asked for.
 *
 * ## Why this replaces a per-token click
 *
 * `InlineSmiles` held `useState(false)` per instance, so an answer naming six compounds was six
 * clicks — and re-parsing the markdown or reloading the page reset every one of them. The opt-in
 * *discipline* was right and is kept: RDKit still gates the affordance, so nothing is ever drawn
 * from a string the recogniser merely guessed at. It was the *granularity* that was wrong.
 *
 * ## Global rather than per-conversation
 *
 * `docs/chemistry-aware-frontend.md` proposed raising it to a per-conversation preference, and this
 * goes one step further on purpose. Per-conversation asks the same question again in every new
 * conversation, which is the per-token failure at a coarser grain — a chemist who wants structures
 * drawn wants them drawn, and one who does not is not changing their mind between threads.
 *
 * ## Not in `chatStore`
 *
 * That store's persisted slice is versioned and migrated, and adding a field to it costs a version
 * bump and a migration step for a boolean that no conversation owns. A bare key, written the way
 * `themeStore` writes one, cannot be part-migrated wrong: a missing or unreadable value is the
 * default, which is exactly what a fresh browser should see.
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
   * Draw a structure wherever an answer names one, without waiting to be asked.
   *
   * Defaults **off**. The affordance a chemist has not asked for should be a button, not a picture:
   * an answer that silently sprouts six drawings the first time someone opens this app is a
   * surprise, and the toggle that turns them on is one click from the same place the button was.
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
