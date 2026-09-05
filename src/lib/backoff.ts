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
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** `sleep(backoffMs(attempt))` — the pair both callers actually want. */
export function backoff(attempt: number, signal: AbortSignal): Promise<void> {
  return sleep(backoffMs(attempt), signal);
}
