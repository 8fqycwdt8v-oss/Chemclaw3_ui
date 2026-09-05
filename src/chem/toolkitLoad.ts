/**
 * How long a chemistry toolkit may take to arrive, asked once.
 *
 * This application lazily fetches two multi-megabyte toolkits, and until now only one of them was
 * bounded. `sketcher.ketcher.tsx` had a 60 s `INIT_TIMEOUT_MS` on the editor coming up;
 * `loadRDKit` had nothing at all, so a request for the 6.9 MB `.wasm` that is *accepted and never
 * answered* — a captive portal, a proxy that swallows the response, a half-open connection after a
 * network change — left the module promise pending for ever. Everything downstream of it waits on
 * that promise, so `SingleMolecule` sat on its reserved aspect-ratio box, the structure panel sat
 * on "Checking…", and neither ever reached the "the toolkit could not be loaded" copy that exists
 * precisely for this. A silent empty box for the life of the page is the one outcome the whole
 * available/unreadable distinction was built to prevent.
 *
 * The two seams answer the same question, so they share the answer rather than growing a second
 * number that drifts from the first. 60 s is deliberately generous: it is not a latency budget, it
 * is the point past which "still downloading" and "never coming" are indistinguishable to a
 * chemist, and both fallbacks — paste and drop for the editor, the SMILES string shown as written
 * for the renderer — are better than a box that never fills.
 *
 * **What it is not.** It does not bound the *work*, only the wait: a load that times out is still
 * in flight, and if it lands afterwards the browser has it cached for the retry. That is why a
 * timeout here must never be memoised as a verdict — see `loadRDKit`'s catch.
 */

export const TOOLKIT_LOAD_TIMEOUT_MS = 60_000;

/**
 * `work`, or a rejection with `timedOutMessage` once the toolkit budget is spent.
 *
 * The timer is cleared however the race ends, so a resolved load does not hold a 60 s handle open
 * — which in a test runner is the difference between a suite that exits and one that hangs.
 */
export function withLoadTimeout<T>(work: Promise<T>, timedOutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(timedOutMessage)), TOOLKIT_LOAD_TIMEOUT_MS);
  });
  // `race` attaches a handler to both, so whichever loses cannot surface as an unhandled rejection.
  return Promise.race([work, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
