/**
 * Entra ID authentication via MSAL (auth code + PKCE), imported dynamically so dev-auth mode never
 * downloads MSAL.
 *
 * Common causes of a valid-looking token being rejected:
 *
 * 1. The scope must be the API's (`api://<api-client-id>/<name>`); an ID token's `aud` is the SPA.
 * 2. The API registration needs `accessTokenAcceptedVersion: 2` (the backend pins the v2 issuer).
 * 3. The backend has no `CHEMCLAW_ENTRA_CLIENT_ID`; the SPA client id lives only here.
 */

import type { AccountInfo, Configuration, IPublicClientApplication } from '@azure/msal-browser';
import { config } from '../env.ts';
import { forgetLocalHistory } from '../state/chatStore.ts';
import type { AuthAccount, AuthProvider } from './types.ts';

/**
 * The authority MSAL signs in against: the configured one (`ENTRA_AUTHORITY`: sovereign cloud,
 * Chemclaw3_mock's tenant) or Entra's public cloud for the tenant.
 */
export const msalAuthority = (): string =>
  config.entraAuthority || `https://login.microsoftonline.com/${config.entraTenantId}`;

export function buildMsalConfig(): Configuration {
  const authority = msalAuthority();
  return {
    auth: {
      // The SPA's app registration — not the API's.
      clientId: config.entraClientId,
      authority,
      // Trust the authority's own host (with port) for discovery, rather than asking Microsoft
      // whether it is a known Entra instance. Protocol mode stays `AAD`.
      knownAuthorities: [new URL(authority).host],
      redirectUri: `${window.location.origin}/auth/callback`,
      postLogoutRedirectUri: window.location.origin,
    },
    cache: {
      // `sessionStorage`: the token dies with the tab. A new tab re-authenticates silently.
      cacheLocation: 'sessionStorage',
    },
  };
}

/** The scopes requested for the Chemclaw API. See point (1) in the module docstring. */
export const apiScopes = (): string[] => [config.apiScope];

/**
 * Where a sign-in started by someone not yet signed in returns to. A `/c/<id>` path is replaced by
 * `/` (that conversation was created in the anonymous slot); `Bootstrap` then picks or creates one
 * in the user's slot once auth has settled. Other paths (`/open/…`, `/jobs/…`, `/review`) are kept.
 * Re-authentication of a signed-in user does not go through this.
 */
export function signInStartPage(location: Pick<Location, 'origin' | 'pathname' | 'href'>): string {
  return /^\/c\/[^/]+\/?$/.test(location.pathname) ? `${location.origin}/` : location.href;
}

/** A sign-in request for somebody not yet signed in — the API scope, returning somewhere real. */
const signInRequest = () => ({
  scopes: apiScopes(),
  redirectStartPage: signInStartPage(window.location),
});

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
        await pca.loginRedirect(signInRequest());
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
      // Redirect, not popup: popups are often blocked and handle Conditional Access poorly; the
      // transcript is already persisted.
      await pca.loginRedirect(signInRequest());
    },

    async logout() {
      // Also forget the persisted conversations (`localStorage`), not just MSAL's cache, for shared
      // workstations.
      forgetLocalHistory();
      sessionStorage.removeItem(REAUTH_KEY);
      await pca.logoutRedirect();
    },

    async handleUnauthorized() {
      // Loop guard: at most one forced re-auth per minute, so a misconfigured scope shows its error
      // instead of looping.
      const last = Number(sessionStorage.getItem(REAUTH_KEY) ?? 0);
      if (Date.now() - last < REAUTH_COOLDOWN_MS) return false;
      sessionStorage.setItem(REAUTH_KEY, String(Date.now()));

      const account = pca.getActiveAccount();
      if (account) await pca.acquireTokenRedirect({ account, scopes: apiScopes() });
      else await pca.loginRedirect(signInRequest());
      return false;
    },
  };
}
