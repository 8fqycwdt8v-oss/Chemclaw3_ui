/**
 * The disabled-auth provider, matching the backend's dev posture.
 *
 * While `CHEMCLAW_ENTRA_REQUIRED=false` the service does not read the Authorization header at all
 * and attributes every request to a shared principal with `oid="dev-user"`. So the honest thing to
 * do is send no header and mirror that principal in the UI.
 */

import { ApiError } from '../api/errors.ts';
import type { AuthProvider } from './types.ts';

export function createDevAuth(): AuthProvider {
  return {
    mode: 'dev',
    account: {
      id: 'dev-user',
      username: 'dev@localhost',
      name: 'Dev principal',
      roles: [],
    },

    async getAccessToken() {
      return null;
    },

    async login() {
      /* nothing to do — there is no sign-in in dev mode */
    },

    async logout() {
      /* nothing to sign out of */
    },

    async handleUnauthorized() {
      // A 401 in dev mode means the backend flipped CHEMCLAW_ENTRA_REQUIRED=true while this UI
      // is still deployed with AUTH_MODE=dev. There is no in-browser recovery — no tenant, no
      // client id, nothing to redirect to — so say precisely that instead of failing vaguely or
      // bouncing the user through a redirect that cannot work.
      throw new ApiError(
        'unauthorized',
        'The Chemclaw service now requires sign-in, but this UI is running in dev auth mode. ' +
          'Redeploy it with AUTH_MODE=bff and the tenant, client id, client secret and API ' +
          'scope configured.',
      );
    },
  };
}
