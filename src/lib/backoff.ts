/**
 * Capped exponential backoff with jitter, and an abortable wait. Shared by `useJobStreams` and the
 * detached-turn recovery poll in `sendMessage.ts`. Jitter matters: a backend restart drops every
 * stream at once, and unjittered retries would herd onto the pod coming up.
 */

/** The longest either caller will ever wait before trying again. */
export const MAX_BACKOFF_MS = 30_000;

/**
 * Delay before attempt `attempt` (1-based): `2^attempt` s capped at `MAX_BACKOFF_MS`, times
 * 0.5–1.0. The exponent is clamped before doubling so it cannot overflow past the cap.
 */
export function backoffMs(attempt: number): number {
  const base = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempt, 5));
  return base * (0.5 + Math.random() * 0.5);
}

/**
 * Wait, resolving early on abort, so an aborted loop stops reconnecting.
 *
 * Whichever of timer and abort wins cleans up both: `{ once: true }` only removes a listener that
 * fires, so without explicit removal every completed wait would leak a listener on a long-lived
 * signal.
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    // Declared after `done` and read only from inside it, which is after `setTimeout` has
    // returned — the two refer to each other, and this is the order that keeps both `const`.
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

/** `sleep(backoffMs(attempt))` — the pair both callers actually want. */
export function backoff(attempt: number, signal: AbortSignal): Promise<void> {
  return sleep(backoffMs(attempt), signal);
}
