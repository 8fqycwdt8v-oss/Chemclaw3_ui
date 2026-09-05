/**
 * Capped exponential backoff with jitter, and an abortable wait.
 *
 * Extracted from `src/hooks/useJobStreams.ts`, which had the only copy and got it right: doubling
 * bounded by a ceiling, multiplied by a random 50–100% so that N clients that failed at the same
 * instant do not retry at the same instant. That property is the whole point — a backend rolling
 * restart drops every open stream and every in-flight turn *simultaneously*, so an unjittered
 * retry from 200 tabs is a synchronised herd against the pod that is still coming up.
 *
 * It is here rather than there because the detached-turn recovery poll in `src/state/sendMessage.ts`
 * needed exactly this and had a fixed 3 s interval instead — 210 unpaginated transcript reads over
 * 630 s, at the same cadence for every client, with the delay never growing even when every request
 * was failing. Two callers, one behaviour: this is the second, which is what makes it an extraction
 * rather than a layer.
 */

/** The longest either caller will ever wait before trying again. */
export const MAX_BACKOFF_MS = 30_000;

/**
 * How long to wait before attempt `attempt` (1-based), jittered.
 *
 * `2^attempt` seconds, capped at `MAX_BACKOFF_MS`, then multiplied by 0.5–1.0. The exponent is
 * clamped before the doubling so a long-lived loop cannot overflow its way past the cap.
 */
export function backoffMs(attempt: number): number {
  const base = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempt, 5));
  return base * (0.5 + Math.random() * 0.5);
}

/**
 * Wait, resolving early if the caller loses interest.
 *
 * A timer nobody cancels outlives the tab's interest in the answer — and worse, it resolves into
 * a `while` loop whose exit condition has already been met, so an aborted stream would keep
 * reconnecting for the life of the page.
 *
 * **Both halves are cleaned up by whichever of them wins, and that is the fix rather than a
 * tidy-up.** `{ once: true }` removes a listener only when the event FIRES, and on the ordinary
 * path it never does: the timer wins, the promise resolves, and the listener stays attached to a
 * signal that lives for the whole stream. Measured in the copy this was extracted from, on a
 * stream held at the 15–30 s cap for 12 simulated hours: **1,931 `abort` listeners added, 0
 * removed**, each retaining its closure and timer id — from one stream, of the three a tab holds.
 * The extraction reintroduced exactly that, in the module whose docstring says it took the version
 * that got it right.
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
