/**
 * The auth seam.
 *
 * The entire application talks to this interface and nothing else — in particular, `streamTurn`
 * and `api` take only a `() => Promise<string | null>`. Switching between the disabled-auth dev
 * posture and real Entra SSO is therefore one factory call in `createAuthProvider`, not a rewrite.
 *
 * `getAccessToken` resolving to `null` means "send no Authorization header". That is exactly what
 * the backend expects while `CHEMCLAW_ENTRA_REQUIRED=false`, where every request is attributed to
 * a shared `dev-user` principal.
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
  readonly mode: 'dev' | 'msal';
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
