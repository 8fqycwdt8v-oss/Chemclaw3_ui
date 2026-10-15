/**
 * Auth provider selection.
 *
 * This is the whole switch between "auth is disabled during development" and signing in through the
 * BFF: one env var, read at runtime from the BFF's `/config.js`. Nothing downstream of
 * `AuthProvider` knows which one it got.
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
  if (config.authMode === 'bff') {
    const { createBffAuth } = await import('./bffAuth.ts');
    return createBffAuth();
  }

  // Dev auth is a dynamic import behind a build-time flag, never an unconditional fallback: that
  // keeps the no-token provider out of the main chunk of every build (grep a release bundle for
  // `dev@localhost`) and leaves it more than one failed `/config.js` fetch away from being active.
  // `server/config.ts` closes the "how did we get into dev mode" half.
  if (!import.meta.env.PROD || __ALLOW_DEV_AUTH__) {
    const { createDevAuth } = await import('./devAuth.ts');
    return createDevAuth();
  }

  throw new Error(
    'AUTH_MODE=dev is not permitted in this production build. Rebuild with ALLOW_DEV_AUTH=true ' +
      'to deliberately ship an unauthenticated UI, or configure AUTH_MODE=bff.',
  );
}
