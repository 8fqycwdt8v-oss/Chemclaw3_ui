/**
 * The storage adapter behind `chatStore`'s persist middleware.
 *
 * It exists for two failures that both live in the gap between "zustand calls setItem" and
 * "localStorage accepts it", and neither of which the store itself can see.
 *
 * **Write amplification.** `persist` runs `partialize` + `JSON.stringify` + a *synchronous*
 * `setItem` on every single `set()`. `appendTokens` fires once per animation frame for the whole
 * of a streaming answer, and `setDraft` fires on every keystroke — and `drafts` is not even in the
 * persisted slice, so those writes serialise the entire transcript to produce a byte-identical
 * blob. Measured on a 30-message transcript that is megabytes of main-thread JSON per answer, all
 * of it blocking the same thread doing the rendering. Coalescing on a short trailing timer keeps
 * one write per burst instead of sixty per second, and `pagehide` flushes so a reload cannot land
 * inside the window.
 *
 * **Quota.** Nothing anywhere in the store caught a throwing `setItem`. `jobFeed` persists whatever
 * a backend `summary` contains, up to fifty entries, so reaching the origin quota is a normal
 * outcome rather than a pathological one — and Safari's private mode throws on the very first
 * write. The throw propagated out of whichever action happened to trigger it: on the send path
 * that is before the turn starts, so the composer never locked and no message was sent, with
 * nothing shown to explain it. Here it is caught, the recoverable space is reclaimed, and if that
 * is still not enough the failure is reported rather than thrown into an unrelated caller.
 */

import type { StateStorage } from 'zustand/middleware';

/** Trailing coalesce window. Long enough to collapse a frame burst, short enough to be invisible. */
const WRITE_DEBOUNCE_MS = 250;

type QuotaListener = (message: string) => void;

let onQuotaExceeded: QuotaListener | null = null;

/** Report an unrecoverable persist failure. Set by `chatStore`, which owns the banner. */
export function setQuotaListener(listener: QuotaListener): void {
  onQuotaExceeded = listener;
}

const isQuotaError = (err: unknown): boolean =>
  err instanceof DOMException &&
  // Chrome/Safari/Firefox disagree on the name, and Firefox historically used code 1014.
  (err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    err.code === 22 ||
    err.code === 1014);

/**
 * Drop what can be dropped, newest-first, and say whether anything was freed.
 *
 * Only `jobFeed` is shed here. Conversations are the user's own history and are never discarded to
 * make room for a write — `partialize` already caps how many are kept.
 */
function reclaim(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { state?: { jobFeed?: unknown[] } };
    if (!parsed.state?.jobFeed?.length) return null;
    parsed.state.jobFeed = [];
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: { key: string; value: string } | null = null;

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
    return;
  } catch (err) {
    if (!isQuotaError(err)) {
      onQuotaExceeded?.('Could not save this conversation locally.');
      return;
    }
    const reduced = reclaim(value);
    if (reduced) {
      try {
        localStorage.setItem(key, reduced);
        return;
      } catch {
        /* fall through to the report below */
      }
    }
    onQuotaExceeded?.(
      'This browser is out of local storage, so new messages are not being saved. Older conversations can be removed from the sidebar.',
    );
  }
}

/** Write anything still queued. Called on `pagehide`, and by tests. */
export function flushPendingWrite(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending) {
    const { key, value } = pending;
    pending = null;
    write(key, value);
  }
}

if (typeof window !== 'undefined') {
  // `pagehide` rather than `beforeunload`: it fires for the bfcache and on mobile task-switching,
  // which `beforeunload` does not.
  window.addEventListener('pagehide', flushPendingWrite);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingWrite();
  });
}

export const coalescedLocalStorage: StateStorage = {
  getItem: (name) => {
    // A queued write is the newest state; reading around it would hand back a stale snapshot.
    if (pending?.key === name) return pending.value;
    return localStorage.getItem(name);
  },

  setItem: (name, value) => {
    pending = { key: name, value };
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flushPendingWrite();
    }, WRITE_DEBOUNCE_MS);
  },

  removeItem: (name) => {
    if (pending?.key === name) pending = null;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    localStorage.removeItem(name);
  },
};
