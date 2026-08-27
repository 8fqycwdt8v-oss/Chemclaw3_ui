/**
 * Entra ID (Azure AD) authentication via MSAL, auth-code + PKCE.
 *
 * This module is imported dynamically so that in dev-auth mode the ~100 KB of MSAL is never
 * downloaded at all.
 *
 * Three configuration facts that account for most "valid-looking token is rejected" incidents,
 * all verified against the backend's service/auth.py:
 *
 *  1. The scope must be the API's own scope (`api://<api-client-id>/<name>`). Requesting only
 *     openid/profile yields an ID token whose `aud` is the SPA's client id, and the backend
 *     checks `aud == CHEMCLAW_ENTRA_AUDIENCE`. Microsoft Graph's `.default` is equally wrong.
 *  2. The backend pins the issuer to `https://login.microsoftonline.com/{tenant}/v2.0`, so the
 *     API app registration needs `accessTokenAcceptedVersion: 2` in its manifest. With the
 *     default (v1) every token is issued by the `sts.windows.net` issuer and 401s.
 *  3. There is no `CHEMCLAW_ENTRA_CLIENT_ID` setting on the backend — its Settings model is
 *     `extra="forbid"`, so exporting one aborts its startup. The SPA client id lives only here.
 */

import type { AccountInfo, Configuration, IPublicClientApplication } from '@azure/msal-browser';
import { config } from '../env.ts';
import { forgetLocalHistory } from '../state/chatStore.ts';
import type { AuthAccount, AuthProvider } from './types.ts';

export function buildMsalConfig(): Configuration {
  return {
    auth: {
      // The SPA's app registration — not the API's.
      clientId: config.entraClientId,
      authority: `https://login.microsoftonline.com/${config.entraTenantId}`,
      knownAuthorities: ['login.microsoftonline.com'],
      redirectUri: `${window.location.origin}/auth/callback`,
      postLogoutRedirectUri: window.location.origin,
    },
    cache: {
      // sessionStorage rather than localStorage: the token dies with the tab, which removes a
      // persistent cross-tab exfiltration target. The cost is a silent re-auth per new tab,
      // which is invisible to the user when the Entra session cookie is still valid.
      cacheLocation: 'sessionStorage',
    },
  };
}

/** The scopes requested for the Chemclaw API. See point (1) in the module docstring. */
export const apiScopes = (): string[] => [config.apiScope];

const toAccount = (account: AccountInfo | null): AuthAccount | null => {
  if (!account) return null;
  const claims = (account.idTokenClaims ?? {}) as Record<string, unknown>;
  return {
    id: typeof claims.oid === 'string' ? claims.oid : account.homeAccountId,
    username: account.username,
    name: account.name ?? account.username,
    roles: Array.isArray(claims.roles) ? claims.roles.map(String) : [],
  };
};

const REAUTH_KEY = 'chemclaw.lastReauth';
const REAUTH_COOLDOWN_MS = 60_000;

export async function createMsalAuth(): Promise<AuthProvider> {
  const { PublicClientApplication, InteractionRequiredAuthError } =
    await import('@azure/msal-browser');

  const pca: IPublicClientApplication = new PublicClientApplication(buildMsalConfig());
  await pca.initialize();

  // Must be awaited before the app renders: the redirect response arrives in the URL fragment,
  // and React's first navigation would discard it.
  const result = await pca.handleRedirectPromise();
  if (result?.account) {
    pca.setActiveAccount(result.account);
  } else if (!pca.getActiveAccount()) {
    const [first] = pca.getAllAccounts();
    if (first) pca.setActiveAccount(first);
  }

  return {
    mode: 'msal',

    get account() {
      return toAccount(pca.getActiveAccount());
    },

    async getAccessToken() {
      const account = pca.getActiveAccount();
      if (!account) {
        await pca.loginRedirect({ scopes: apiScopes() });
        return null;
      }
      try {
        // Cache hit in the common case; MSAL refreshes silently a few minutes before expiry.
        // Calling this per request is the documented pattern, not a performance problem.
        const response = await pca.acquireTokenSilent({ account, scopes: apiScopes() });
        return response.accessToken;
      } catch (err) {
        if (err instanceof InteractionRequiredAuthError) {
          await pca.acquireTokenRedirect({ account, scopes: apiScopes() });
          return null; // navigation in flight; this request is abandoned
        }
        throw err;
      }
    },

    async login() {
      // Redirect rather than popup: popups are blocked by default in several enterprise browser
      // configurations, and Conditional Access / MFA / device-compliance flows render badly
      // inside one. The usual objection — that a redirect destroys unsaved UI state — does not
      // apply here because the transcript is persisted before we ever navigate.
      await pca.loginRedirect({ scopes: apiScopes() });
    },

    async logout() {
      // The transcripts are not MSAL's to clear: its cache holds the credential, in
      // `sessionStorage`, and every conversation is persisted separately to `localStorage`. A
      // sign-out that removes only the first leaves the second for whoever signs in next on the
      // same browser profile — which on a shared lab workstation is a different chemist.
      forgetLocalHistory();
      sessionStorage.removeItem(REAUTH_KEY);
      await pca.logoutRedirect();
    },

    async handleUnauthorized() {
      // Loop guard. A misconfigured audience or scope produces a 401 on every request, and
      // without this the app would redirect-loop — which is indistinguishable from a hang and
      // hides the actual error. At most one forced re-auth per minute.
      const last = Number(sessionStorage.getItem(REAUTH_KEY) ?? 0);
      if (Date.now() - last < REAUTH_COOLDOWN_MS) return false;
      sessionStorage.setItem(REAUTH_KEY, String(Date.now()));

      const account = pca.getActiveAccount();
      if (account) await pca.acquireTokenRedirect({ account, scopes: apiScopes() });
      else await pca.loginRedirect({ scopes: apiScopes() });
      return false;
    },
  };
}
