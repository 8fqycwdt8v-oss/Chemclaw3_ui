/**
 * Auth provider selection.
 *
 * This is the whole switch between "auth is disabled during development" and "real Entra SSO":
 * one env var, read at runtime from the BFF's `/config.js`. Nothing downstream of `AuthProvider`
 * knows which one it got.
 */

import { config } from '../env.ts';
import { createDevAuth } from './devAuth.ts';
import type { AuthProvider } from './types.ts';

export type { AuthAccount, AuthProvider } from './types.ts';

export async function createAuthProvider(): Promise<AuthProvider> {
  if (config.authMode === 'msal') {
    // Dynamic import keeps MSAL out of the bundle entirely on the dev path.
    const { createMsalAuth } = await import('./msalAuth.ts');
    return createMsalAuth();
  }
  return createDevAuth();
}
