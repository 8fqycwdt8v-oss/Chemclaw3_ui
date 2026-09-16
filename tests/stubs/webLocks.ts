/**
 * A `LockManager` for the suite, because the one the browser ships is what `jobStreamLeader`
 * elects with and happy-dom's `navigator.locks` is **`null`**.
 *
 * Not a convenience. Without it every membership in the suite takes the module's documented
 * "cannot coordinate" branch and leads alone, so every case about two tabs agreeing would pass
 * while asserting nothing — which is the shape of failure `tests/entryChunk.test.ts` calls "a basis
 * that agrees with itself forever", arriving through a missing API rather than a stale probe.
 *
 * What it models is one realm, and that is the right model rather than a simplification: two tabs
 * of one origin share one lock manager, and the two memberships in a test case share this one. What
 * it does **not** model is the part the module now depends on a real browser for — a lock released
 * because the context died. A test drives that by releasing, which is exactly what the browser
 * does on the tab's behalf, and `close({ announce: false })` in the module is written to release
 * for the same reason.
 *
 * Exclusive mode only: it is the only mode this app asks for, and a `shared` implementation with no
 * caller would be a claim that the stand-in is general.
 */

/** A lock this stand-in has granted or queued, keyed by name. */
interface Entry {
  held: boolean;
  /** Waiters, in request order. Web Locks is FIFO and a test that depended on it being anything
   *  else would be asserting on this file rather than on the browser. */
  queue: (() => void)[];
}

class StandInLockManager implements LockManager {
  private readonly entries = new Map<string, Entry>();

  private entry(name: string): Entry {
    let found = this.entries.get(name);
    if (!found) {
      found = { held: false, queue: [] };
      this.entries.set(name, found);
    }
    return found;
  }

  async request(name: string, ...rest: unknown[]): Promise<unknown> {
    const callback = (rest.length > 1 ? rest[1] : rest[0]) as (lock: Lock) => unknown;
    const options = (rest.length > 1 ? rest[0] : {}) as LockOptions;
    const entry = this.entry(name);

    if (entry.held) await new Promise<void>((resolve) => entry.queue.push(resolve));
    entry.held = true;

    try {
      return await callback({ name, mode: options.mode ?? 'exclusive' });
    } finally {
      // Hand straight to the next waiter rather than clearing `held` and letting it re-take it:
      // a request arriving synchronously in between would otherwise jump a queue the browser keeps
      // in order, and a test would be watching this file's race instead of the module's logic.
      const next = entry.queue.shift();
      if (next) next();
      else entry.held = false;
    }
  }

  async query(): Promise<LockManagerSnapshot> {
    const held: LockInfo[] = [];
    const pending: LockInfo[] = [];
    for (const [name, entry] of this.entries) {
      if (entry.held) held.push({ name, mode: 'exclusive' });
      for (let i = 0; i < entry.queue.length; i += 1) pending.push({ name, mode: 'exclusive' });
    }
    return { held, pending };
  }
}

/**
 * Put a fresh manager on `navigator` and return the undo.
 *
 * Fresh per case, because a lock left held by a membership a previous case forgot to close would
 * make the next one a follower for reasons it could not see — the slowest possible way to find a
 * teardown bug.
 */
export function installLockManager(): () => void {
  const had = Object.getOwnPropertyDescriptor(navigator, 'locks');
  Object.defineProperty(navigator, 'locks', {
    value: new StandInLockManager(),
    configurable: true,
    writable: true,
  });
  return () => {
    // Restored rather than deleted: `locks` is a non-optional property of `Navigator`, and the
    // environment this suite runs in defines it (as `null`) before any of this.
    if (had) Object.defineProperty(navigator, 'locks', had);
    else Object.defineProperty(navigator, 'locks', { value: null, configurable: true });
  };
}
