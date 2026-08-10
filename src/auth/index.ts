/**
 * Auth provider selection.
 *
 * This is the whole switch between "auth is disabled during development" and "real Entra SSO":
 * one env var, read at runtime from the BFF's `/config.js`. Nothing downstream of `AuthProvider`
 * knows which one it got.
 */

import { config } from '../env.ts';
import type { AuthProvider } from './types.ts';

export type { AuthAccount, AuthProvider } from './types.ts';

/**
 * Whether a production bundle is permitted to serve the no-token dev provider.
 *
 * Injected by Vite's `define` from `ALLOW_DEV_AUTH`, so in a normal production build this is the
 * literal `false` and the branch below is statically dead. `start.sh`, `docker-compose.yml` and
 * the e2e build set it explicitly, because a production *bundle* running dev auth is a supported
 * deployment — what must not be supported is reaching it by accident.
 */
declare const __ALLOW_DEV_AUTH__: boolean;

export async function createAuthProvider(): Promise<AuthProvider> {
  if (config.authMode === 'msal') {
    // Dynamic import keeps MSAL out of the bundle entirely on the dev path.
    const { createMsalAuth } = await import('./msalAuth.ts');
    return createMsalAuth();
  }

  // Dev auth used to be a STATIC import and an unconditional fallback. That put the no-token
  // provider in the main chunk of every build — verifiable by grepping a release bundle for
  // `dev@localhost`, which found it — and left it one failed `/config.js` fetch away from being
  // the active provider, sending no `Authorization` header at all. `server/config.ts` closes the
  // "how did we get into dev mode" half; this closes the "and then it worked anyway" half.
  if (!import.meta.env.PROD || __ALLOW_DEV_AUTH__) {
    const { createDevAuth } = await import('./devAuth.ts');
    return createDevAuth();
  }

  throw new Error(
    'AUTH_MODE=dev is not permitted in this production build. Rebuild with ALLOW_DEV_AUTH=true ' +
      'to deliberately ship an unauthenticated UI, or configure AUTH_MODE=msal.',
  );
}
