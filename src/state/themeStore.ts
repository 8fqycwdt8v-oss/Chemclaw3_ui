/**
 * Theme choice.
 *
 * Three choices the user can make (`light` / `dark` / `system`), one resolved value
 * (`light` / `dark`) reflected as `data-theme` on <html>.
 *
 * Deliberately NOT zustand's `persist` middleware. That writes
 * `{"state":{…},"version":0}`, which `public/theme-boot.js` would then have to JSON-parse
 * in the render-blocking path — more code before first paint, and a coupling to the
 * storage envelope of a library the boot script otherwise knows nothing about. A bare
 * string is the contract between the two.
 *
 * An attribute rather than a class because <html> already carries `class="h-full"`, and
 * an attribute cannot be clobbered by a stray className write.
 */

import { create } from 'zustand';

export type ThemeChoice = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

/** Must match the key read by public/theme-boot.js. */
const STORAGE_KEY = 'chemclaw3.theme';

const darkQuery = (): MediaQueryList | null =>
  typeof window === 'undefined' ? null : (window.matchMedia?.('(prefers-color-scheme: dark)') ?? null);

const systemTheme = (): ResolvedTheme => (darkQuery()?.matches ? 'dark' : 'light');

const readChoice = (): ThemeChoice => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
};

const resolve = (choice: ThemeChoice): ResolvedTheme =>
  choice === 'system' ? systemTheme() : choice;

const apply = (resolved: ResolvedTheme): void => {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = resolved;
};

interface ThemeState {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
  setChoice: (choice: ThemeChoice) => void;
  /** Re-resolve from the OS. Called by the matchMedia listener below. */
  syncSystem: () => void;
}

const initialChoice = readChoice();

export const useThemeStore = create<ThemeState>()((set, get) => ({
  choice: initialChoice,
  resolved: resolve(initialChoice),

  setChoice(choice) {
    try {
      if (choice === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      // Non-persistent is still usable for this session.
    }
    const resolved = resolve(choice);
    apply(resolved);
    set({ choice, resolved });
  },

  syncSystem() {
    if (get().choice !== 'system') return;
    const resolved = systemTheme();
    apply(resolved);
    set({ resolved });
  },
}));

// Follow the OS while the choice is "system". Registered once at module scope: there is
// exactly one <html> and this outlives any component that might care.
darkQuery()?.addEventListener('change', () => useThemeStore.getState().syncSystem());
