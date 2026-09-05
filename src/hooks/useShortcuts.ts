/**
 * The keys a chemist who is here all day learns.
 *
 * There were two `onKeyDown` handlers in the whole app — Cmd/Ctrl+Enter to send, and Enter to
 * accept a structure — both bound to the control they act on. Nothing was bound at the app level,
 * so every navigation was a pointer trip: new conversation, find an old one, stop a turn that is
 * going the wrong way.
 *
 * Four rules this follows, and each of them is why some of the obvious bindings are missing:
 *
 *  - **Nothing fires while the reader is typing.** A chemist writing "N-Boc" would otherwise open
 *    a new conversation on the `n`. So every binding here carries a modifier, and every one is
 *    additionally suppressed inside a text control — belt and braces, because a browser or an
 *    extension can swallow a modifier and leave the bare key.
 *  - **Nothing shadows a browser binding a chemist relies on.** Ctrl/Cmd+F is find-in-page, and a
 *    lab notebook page is exactly where somebody uses it. The search box gets `/`-with-modifier
 *    rather than taking it.
 *  - **Escape is not bound here.** Radix owns it for every open sheet, dialog and menu, and a
 *    global handler would race them — the composer's Stop is a visible control and stays one.
 *  - **The list is discoverable or it does not exist.** `?` opens the sheet that names them, which
 *    is the only reason to believe anybody will find the rest.
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
      // **A window listener is not stopped by a focus trap**, so every one of these fired while a
      // Radix Sheet or AlertDialog was open. Measured: with the protocol editor open and edits
      // pending, Cmd+K created a conversation and navigated — unmounting the editor, taking the
      // draft with it, and bypassing the unsaved-edit guard entirely, because an SPA navigation
      // fires no `beforeunload` either.
      //
      // Radix sets `data-scroll-locked` on `<body>` for exactly the span a modal owns the screen,
      // which is the cheapest reliable signal available here and the one that stays correct for a
      // dialog this hook has never heard of.
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
