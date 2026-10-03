/**
 * How often an open shared conversation reads its session's line (`GET /sessions/{id}/queue`) to
 * notice somebody else's running turn (`src/state/sharedSync.ts`, Chemclaw3_ui #130).
 *
 * Shared by both halves of `/config.js` for the reason `isUsableMessageCap` is: the BFF reads
 * `SHARED_POLL_MS` and refuses to boot on a value that is not an interval (`server/config.ts`), and
 * the SPA re-checks what crossed the bridge and keeps the default instead (`src/env.ts`). One
 * predicate, so the two cannot disagree about what "usable" means.
 *
 * Dependency-free on purpose: both the BFF bundle and the SPA's first load import it.
 */

/** The default cadence: one small GET every five seconds, and a colleague's turn appears here at
 *  most that long after they press Send. */
export const SHARED_POLL_MS = 5_000;

/** The fastest cadence a deployment may ask for. Below this the line is asked more often than a
 *  person could notice the difference, and every open shared conversation pays for it upstream. */
export const MIN_SHARED_POLL_MS = 250;

/** A whole number of milliseconds, no faster than `MIN_SHARED_POLL_MS`. */
export const isUsablePollInterval = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= MIN_SHARED_POLL_MS;
