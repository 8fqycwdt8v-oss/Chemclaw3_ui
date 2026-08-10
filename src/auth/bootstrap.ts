/**
 * Start authentication at module scope, before React renders.
 *
 * Two things this buys, and one it does not.
 *
 * It buys latency in `msal` mode: the MSAL chunk fetch, `initialize()` and `handleRedirectPromise()`
 * leave the critical path to first paint. In `dev` mode it buys essentially nothing —
 * `createDevAuth()` is a pure object literal, so the old effect-based start cost one microtask.
 * Do not measure this in dev and conclude it worked.
 *
 * It also fixes a StrictMode double-invoke: the previous `useEffect` start constructed two
 * `PublicClientApplication` instances in development and discarded one. A module-scope promise is
 * created once.
 *
 * It is NOT the fragment fix. `handleRedirectPromise()` is still async and React can mount while
 * `#code=` is on the address bar. What keeps that safe is the `/auth/callback` route, whose
 * element writes no URL — see `src/routes.tsx`.
 */

import { createAuthProvider } from './index.ts';
import type { AuthProvider } from './types.ts';

export const authReady: Promise<AuthProvider> = createAuthProvider();

/**
 * Start over after a failed bootstrap.
 *
 * The module-scope promise above is created once on purpose, and that is what makes a failure
 * permanent: it is already rejected, so nothing awaiting it can ever succeed and the app sits
 * with everything token-gated disabled behind a dismissable banner. This is the only way back,
 * and it is deliberately explicit — a user pressing "Try again", never an automatic retry.
 *
 * Constructing a second provider is safe *here* precisely because the first one failed; the
 * StrictMode double-invoke this module exists to prevent is a mount-time hazard, not this.
 */
export function restartAuth(): Promise<AuthProvider> {
  return createAuthProvider();
}
