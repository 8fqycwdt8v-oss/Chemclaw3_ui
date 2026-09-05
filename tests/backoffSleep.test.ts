/**
 * The shared wait, and the leak the extraction reintroduced.
 *
 * `src/lib/backoff.ts` says it was extracted from `src/hooks/useJobStreams.ts`, "which had the only
 * copy and got it right". It did not take all of it: the hook's `sleep` removes its own `abort`
 * listener when the timer wins, and the extracted one registered with `{ once: true }` instead —
 * which removes a listener only when the event FIRES, and on the ordinary path it never does.
 *
 * Measured in the hook before that fix, over 12 simulated hours at the 15–30 s cap:
 * **1,931 `abort` listeners added, 0 removed**, each retaining its closure and timer id, from one
 * stream of the three a tab holds. `tests/jobStreamListeners.test.ts` pins it for the hook, through
 * the whole `useJobStreams` machinery. This pins it for the function itself, because the second
 * caller — the detached-turn recovery poll in `sendMessage.ts` — is a `while` loop on the same
 * signal and would leak exactly the same way with that test still green.
 *
 * There is one copy of this function now. Until this file was written there were two, one of them
 * fixed and one of them not, in a module documenting the fixed one.
 */

import { describe, expect, it, vi } from 'vitest';
import { backoffMs, sleep, MAX_BACKOFF_MS } from '../src/lib/backoff.ts';

/** A signal that counts what is attached to it and what is taken off again. */
function countingSignal(): { signal: AbortSignal; abort: () => void; live: () => number } {
  const controller = new AbortController();
  const signal = controller.signal;
  let added = 0;
  let removed = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  Object.defineProperty(signal, 'addEventListener', {
    value: (...args: Parameters<AbortSignal['addEventListener']>) => {
      added += 1;
      add(...args);
    },
  });
  Object.defineProperty(signal, 'removeEventListener', {
    value: (...args: Parameters<AbortSignal['removeEventListener']>) => {
      removed += 1;
      remove(...args);
    },
  });
  return { signal, abort: () => controller.abort(), live: () => added - removed };
}

describe('sleep', () => {
  it('leaves no listener behind when the timer wins', async () => {
    vi.useFakeTimers();
    try {
      const { signal, live } = countingSignal();

      // Twenty waits in a row is a poll that has been running a few minutes, not a stress test.
      for (let i = 0; i < 20; i += 1) {
        const waited = sleep(1_000, signal);
        await vi.advanceTimersByTimeAsync(1_000);
        await waited;
      }

      expect(live()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves at once on a signal that is already aborted', async () => {
    const { signal, abort } = countingSignal();
    abort();
    // No timers advanced: a wait that queued a 30-second timer here would hold a `while` loop open
    // long after its exit condition was met.
    await expect(sleep(30_000, signal)).resolves.toBeUndefined();
  });

  it('resolves when the wait is aborted mid-flight, and detaches', async () => {
    vi.useFakeTimers();
    try {
      const { signal, abort, live } = countingSignal();
      const waited = sleep(30_000, signal);
      abort();
      await waited;
      expect(live()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('backoffMs', () => {
  it('doubles, jitters between half and full, and never passes the ceiling', () => {
    // The jitter is the point rather than a detail: a rolling restart drops every open stream at
    // the same instant, so an unjittered retry from 200 tabs is a synchronised herd.
    for (const attempt of [1, 2, 3, 4, 5, 6, 20, 200]) {
      const base = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempt, 5));
      for (let i = 0; i < 50; i += 1) {
        const ms = backoffMs(attempt);
        expect(ms).toBeGreaterThanOrEqual(base * 0.5);
        expect(ms).toBeLessThanOrEqual(base);
        expect(ms).toBeLessThanOrEqual(MAX_BACKOFF_MS);
      }
    }
  });
});
