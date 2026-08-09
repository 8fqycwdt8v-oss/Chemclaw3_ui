/**
 * The auth seam.
 *
 * The entire application talks to this interface and nothing else — in particular, `streamTurn`
 * and `api` take only a `() => Promise<string | null>`. Switching between the disabled-auth dev
 * posture and real Entra SSO is therefore one factory call in `createAuthProvider`, not a rewrite.
 *
 * `getAccessToken` resolving to `null` means "send no Authorization header", and two quite
 * different modes rely on it. In `dev` it means what it looks like: the backend has
 * `CHEMCLAW_ENTRA_REQUIRED=false` and attributes every request to a shared `dev-user` principal. In
 * `bff` it means the request is authenticated by cookie and the BFF will attach the real token
 * server-side — the user is fully signed in and this page simply never sees their token.
 *
 * That second case is why nothing downstream may treat a `null` token as "not signed in". Check
 * `account`, which is the actual answer to that question in every mode.
 */

export interface AuthAccount {
  /** The Entra object id (`oid`) — the same value the backend attributes every action to. */
  id: string;
  username: string;
  name: string;
  /** App roles from the token's `roles` claim. The backend gates expensive tools on these;
   *  reading them here is only for greying out affordances, never for enforcement. */
  roles: string[];
}

export interface AuthProvider {
  /** Mirrors the resolved `AuthMode`. `bff` is the mode in which `getAccessToken` returns `null`
   *  even though the user is fully signed in — the token is held by the server. */
  readonly mode: 'dev' | 'msal-spa' | 'bff';
  readonly account: AuthAccount | null;
  getAccessToken(): Promise<string | null>;
  login(): Promise<void>;
  logout(): Promise<void>;
  /**
   * Called when the API returns 401. Returns true if a fresh token is now available and the
   * caller should retry; false if an interactive redirect is in flight or re-auth was suppressed.
   */
  handleUnauthorized(): Promise<boolean>;
}
