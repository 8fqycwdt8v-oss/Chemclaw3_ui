/**
 * The seam between the turn orchestrator and the app's live region.
 *
 * The orchestrator runs outside React and needs to say "the answer finished" to a DOM node it does
 * not own. Rather than have `state/` import from `components/`, the region registers itself here
 * and the orchestrator talks to this.
 *
 * What goes through here is TRANSITIONS ONLY — one short sentence when the turn changes state.
 * The streaming text itself deliberately carries `aria-busy` and no live region: at one mutation
 * per animation frame, a live region makes NVDA and JAWS queue every mutation and stutter through
 * the whole answer from the top, repeatedly.
 *
 * Assertive messages (a failed turn, a degraded capability) do not come through here; they use
 * `role="alert"` at their own call sites, because they need to interrupt.
 */

type Sink = (message: string) => void;

let sink: Sink | null = null;

/** Called by the live region on mount. Returns a disposer. */
export function registerAnnouncer(fn: Sink): () => void {
  sink = fn;
  return () => {
    if (sink === fn) sink = null;
  };
}

/** Announce a state transition politely. A no-op if no region is mounted. */
export function announceStatus(message: string): void {
  sink?.(message);
}

/** "Answer complete, 320 words." — a length cue is what tells a listener whether to settle in. */
export function describeAnswer(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return `Answer complete, ${words} ${words === 1 ? 'word' : 'words'}.`;
}
