/**
 * App-level keyboard shortcuts. Rules:
 * - Every binding has a modifier and is suppressed inside text controls.
 * - No browser binding a chemist relies on is shadowed (Ctrl/Cmd+F stays find-in-page).
 * - Escape is not bound; Radix owns it for sheets, dialogs and menus.
 * - `?` opens the sheet listing them all.
 */

import { useEffect } from 'react';

/** One binding: how to say it, what it does, and what to call it in the list. */
export interface Shortcut {
  /** `key` as the browser reports it, lowercased. */
  key: string;
  /** Ctrl on Windows/Linux, Cmd on macOS — the platform's own "this is an app command" modifier. */
  mod?: boolean;
  shift?: boolean;
  /** What the sheet calls it. */
  label: string;
  run: () => void;
}

/** Whether the event landed somewhere the reader is composing text. */
function inTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** The platform's command modifier, so one binding reads correctly on both. */
export const modKey = (): string =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

/** Render one binding the way the sheet shows it. */
export const describeShortcut = (s: Shortcut): string =>
  [s.mod ? modKey() : '', s.shift ? 'Shift' : '', s.key === ' ' ? 'Space' : s.key.toUpperCase()]
    .filter(Boolean)
    .join(' + ');

export function useShortcuts(shortcuts: Shortcut[]): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // `?` is the one binding without a command modifier, because it is punctuation rather than a
      // letter and cannot be produced by ordinary prose keystrokes outside a text control — which
      // this still refuses to fire inside.
      if (inTextEntry(e.target)) return;
      // Skip while a modal is open: window listeners ignore focus traps, so a shortcut could
      // navigate away and lose an editor's unsaved draft (SPA navigation fires no `beforeunload`).
      // Radix sets `data-scroll-locked` on `<body>` exactly while a modal owns the screen.
      if (document.body.hasAttribute('data-scroll-locked')) return;
      const mod = e.metaKey || e.ctrlKey;
      for (const shortcut of shortcuts) {
        if (e.key.toLowerCase() !== shortcut.key) continue;
        if (Boolean(shortcut.mod) !== mod) continue;
        if (Boolean(shortcut.shift) !== e.shiftKey) continue;
        e.preventDefault();
        shortcut.run();
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shortcuts]);
}
