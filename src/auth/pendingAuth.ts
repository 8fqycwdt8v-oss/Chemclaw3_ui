/**
 * The provider the app renders against while the real one is still resolving.
 *
 * Two details here are load-bearing and both are easy to get wrong:
 *
 *  - `mode` is the CONFIGURED mode, not `'dev'`. `TopBar` reads `auth.mode` during render, so a
 *    `'dev'` placeholder would flash the amber "dev auth — no sign-in" badge on every production
 *    boot. The configured mode is known synchronously from `/config.js`, so there is nothing to
 *    guess.
 *
 *  - `getAccessToken` THROWS rather than resolving `null`. `null` is not "no token yet" in this
 *    codebase, it is "send no Authorization header" (see `types.ts`) — correct under dev auth and
 *    a 401 storm under Entra. Throwing fails loudly in dev and test rather than quietly in
 *    production, and every caller is already inside a try/catch or a gate.
 */

import { ApiError } from '../api/errors.ts';
import { config } from '../env.ts';
import type { AuthProvider } from './types.ts';

export class AuthNotReadyError extends ApiError {
  constructor() {
    super('unauthorized', 'Signing in — this action is not available yet.');
  }
}

export const pendingAuth: AuthProvider = {
  mode: config.authMode,
  account: null,

  async getAccessToken(): Promise<string | null> {
    throw new AuthNotReadyError();
  },

  async login() {
    /* The real provider owns the redirect; nothing to do before it exists. */
  },

  async logout() {
    /* Nothing to sign out of yet. */
  },

  async handleUnauthorized(): Promise<boolean> {
    return false;
  },
};
