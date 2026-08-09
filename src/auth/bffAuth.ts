/**
 * The provider for BFF token custody: the mode where this page never holds a bearer token.
 *
 * `getAccessToken()` resolves to `null`, permanently and by design, and that is the whole point.
 * Under `msal-spa` a token sits in `sessionStorage` for the life of the tab, which means any script
 * that can run on this origin — a compromised dependency, a markdown renderer with a hole in it,
 * an extension — can read it and use it from anywhere, for its full lifetime. Here the token lives
 * in an httpOnly cookie the page cannot read, so the worst an injected script can do is make
 * requests *from this origin while the user is here*, which is a materially smaller blast radius
 * and one the CSP and CSRF checks also bear on.
 *
 * The exchange is that this provider is stateless about tokens and asks the BFF who the user is.
 */

import { ApiError } from '../api/errors.ts';
import { CREDENTIALS, credentialHeaders } from '../api/http.ts';
import type { AuthAccount, AuthProvider } from './types.ts';

/** Bounded, so a hung BFF leaves the app on a sign-in screen rather than on "Starting…" forever. */
const ME_TIMEOUT_MS = 10_000;

interface MeResponse {
  authenticated?: boolean;
  id?: string;
  username?: string;
  name?: string;
  roles?: unknown;
}

async function fetchAccount(): Promise<AuthAccount | null> {
  let res: Response;
  try {
    res = await fetch('/auth/me', {
      credentials: CREDENTIALS,
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(ME_TIMEOUT_MS),
    });
  } catch {
    // Deliberately not fatal. A BFF that cannot answer /auth/me will not be able to serve the API
    // either, and the app's existing "could not reach the service" path says that better than a
    // sign-in failure would. Treating it as "not signed in" shows the sign-in button, which is
    // both true and the only useful thing to offer.
    return null;
  }
  if (!res.ok) return null;

  const body = (await res.json().catch(() => ({}))) as MeResponse;
  if (body.authenticated !== true || typeof body.id !== 'string' || body.id === '') return null;
  return {
    id: body.id,
    username: typeof body.username === 'string' ? body.username : '',
    name: typeof body.name === 'string' && body.name !== '' ? body.name : (body.username ?? ''),
    roles: Array.isArray(body.roles)
      ? body.roles.filter((r): r is string => typeof r === 'string')
      : [],
  };
}

/** Where to come back to after signing in — path only, and the server validates it again. */
const here = (): string => `${window.location.pathname}${window.location.search}`;

/**
 * Start a sign-in: a full-page navigation, not a popup or a hidden frame.
 *
 * The BFF has to see the return leg to set the session cookie, so the browser must actually travel
 * to `/auth/login` and back. That also means unsaved composer text is lost — which is why this is
 * only ever reached from an explicit Sign in button or from a confirmed-dead session.
 *
 * It never resolves. Navigation is asynchronous, so settling would let a caller act as though
 * sign-in had finished; the page is going away instead.
 */
async function startLogin(): Promise<never> {
  window.location.assign(`/auth/login?returnTo=${encodeURIComponent(here())}`);
  return new Promise<never>(() => {});
}

export async function createBffAuth(): Promise<AuthProvider> {
  let account = await fetchAccount();

  return {
    mode: 'bff',
    get account() {
      return account;
    },

    /**
     * Always `null`, and not a stub.
     *
     * The seam `types.ts` describes is `() => Promise<string | null>`, where `null` already means
     * "send no Authorization header" — the dev provider has returned it since the beginning. So
     * every caller in the app already handles this correctly and none of them needed changing:
     * the request goes out with a cookie instead, and the BFF attaches the token.
     */
    async getAccessToken() {
      return null;
    },

    login: startLogin,

    async logout() {
      const res = await fetch('/auth/logout', {
        method: 'POST',
        credentials: CREDENTIALS,
        cache: 'no-store',
        headers: { accept: 'application/json', ...credentialHeaders(null) },
      });
      account = null;
      // Sign out of the tenant too, not just of this app. Without it the next sign-in is silent
      // and instant, which looks exactly like the logout having done nothing.
      const body = (await res.json().catch(() => ({}))) as { signOutUrl?: string };
      window.location.assign(typeof body.signOutUrl === 'string' ? body.signOutUrl : '/');
      await new Promise<never>(() => {});
    },

    /**
     * A 401 from the backend, which here means one of two quite different things.
     *
     * Either the session is gone — expired past what the BFF's proactive refresh covers, or
     * revoked — in which case signing in again is the fix. Or the session is fine and the backend
     * refused the token for its own reason (an audience or issuer misconfiguration, most likely),
     * in which case a redirect to Entra would succeed, come back, and hit exactly the same 401:
     * an infinite bounce that is very hard to read from the outside.
     *
     * Asking `/auth/me` is what tells them apart, and it is cheap.
     *
     * Returns `false` rather than never settling, unlike `login()`. That is the interface's
     * documented contract — "false if an interactive redirect is in flight" — and `sendMessage`
     * relies on it to unlock the composer and settle the turn. Navigation is already under way by
     * then, so the caller's error handling usually never renders; when the browser is slow to
     * leave, a settled turn is a much better thing to be looking at than a caret that never stops.
     */
    async handleUnauthorized() {
      account = await fetchAccount();
      if (account === null) {
        void startLogin();
        return false;
      }
      throw new ApiError(
        'unauthorized',
        'You are signed in, but the Chemclaw service rejected the request. This usually means the ' +
          'API scope or app registration is misconfigured rather than that your session expired.',
      );
    },
  };
}
