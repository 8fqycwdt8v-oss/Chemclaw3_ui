/**
 * Sign-in through the BFF's token handler.
 *
 * The BFF completes the OIDC exchange and keeps every token; this module only asks it who is
 * signed in (`GET /auth/session`), sends the browser to `/auth/login` when nobody is, and ends the
 * session (`POST /auth/logout`). The session cookie is `HttpOnly`, so nothing here can read it, and
 * no request carries an `Authorization` header: `getAccessToken()` is always `null`, which the
 * seam already reads as "send none" (the BFF injects the bearer).
 *
 * A browser that comes back from the provider with the sign-in marker and still no session did not
 * keep the cookie (blocked, or a clock far off). It stops there with a message instead of
 * redirecting again, which would loop for ever.
 */

import { AUTH_PATHS, CSRF_HEADER, CSRF_VALUE, SIGNED_IN_MARKER } from '../../shared/auth.ts';
import type { AccountView, LogoutView, SessionView } from '../../shared/auth.ts';
import { ApiError } from '../api/errors.ts';
import { forgetLocalHistory } from '../state/chatStore.ts';
import type { AuthAccount, AuthProvider } from './types.ts';

/**
 * Where a sign-in started by someone not yet signed in returns to. A `/c/<id>` path is replaced by
 * `/` (that conversation was created in the anonymous slot); `Bootstrap` then picks or creates one
 * in the user's slot once auth has settled. Other paths (`/open/…`, `/jobs/…`, `/review`) are kept.
 * The marker is removed so a return never carries a stale one.
 */
export function signInReturnTo(location: Pick<Location, 'pathname' | 'search' | 'hash'>): string {
  if (/^\/c\/[^/]+\/?$/.test(location.pathname)) return '/';
  const params = new URLSearchParams(location.search);
  params.delete(SIGNED_IN_MARKER);
  const search = params.size > 0 ? `?${params.toString()}` : '';
  return `${location.pathname}${search}${location.hash}`;
}

/** The `/auth/login` URL for a return target. */
export const loginUrl = (returnTo: string): string =>
  `${AUTH_PATHS.login}?returnTo=${encodeURIComponent(returnTo)}`;

/** Whether this page load is the one the provider sent the browser back to. */
const cameBackFromSignIn = (): boolean =>
  new URLSearchParams(window.location.search).has(SIGNED_IN_MARKER);

/** Drop the marker from the address bar without disturbing the router's history entry. */
function removeMarker(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(SIGNED_IN_MARKER)) return;
  url.searchParams.delete(SIGNED_IN_MARKER);
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

async function readSession(): Promise<SessionView> {
  const res = await fetch(AUTH_PATHS.session, { cache: 'no-store' });
  if (!res.ok) throw new Error(`The sign-in check answered ${res.status}.`);
  return (await res.json()) as SessionView;
}

const toAccount = (account: AccountView): AuthAccount => ({
  id: account.id,
  username: account.username,
  name: account.name,
  roles: account.roles,
});

/** One navigation to the provider at a time, however many requests found the session gone. */
let leaving = false;

function goToLogin(returnTo: string): void {
  if (leaving) return;
  leaving = true;
  window.location.assign(loginUrl(returnTo));
}

/** Send the browser to sign in, returning to the page it is on. */
export const startLogin = (): void => goToLogin(signInReturnTo(window.location));

export async function createBffAuth(): Promise<AuthProvider> {
  // A page restored from the back/forward cache after the sign-in navigation still says it is
  // leaving; reloading starts it afresh and asks the BFF again.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) window.location.reload();
  });
  let view: SessionView;
  try {
    view = await readSession();
  } catch (err) {
    throw err instanceof Error ? err : new Error('Could not check whether you are signed in.');
  }

  if (!view.authenticated || !view.account) {
    if (cameBackFromSignIn()) {
      removeMarker();
      throw new Error(
        'You signed in, but this browser did not keep the session. Allow cookies for this site and try again.',
      );
    }
    startLogin();
    // The page is navigating away; nothing renders against a signed-out session.
    return new Promise<AuthProvider>(() => undefined);
  }
  removeMarker();
  const account = toAccount(view.account);

  return {
    mode: 'bff',
    account,

    async getAccessToken() {
      return null;
    },

    async login() {
      startLogin();
    },

    async logout() {
      const res = await fetch(AUTH_PATHS.logout, {
        method: 'POST',
        headers: { [CSRF_HEADER]: CSRF_VALUE },
      });
      if (!res.ok) throw new ApiError('network', 'Could not sign out. Try again.');
      const body = (await res.json()) as LogoutView;
      // Also forget the persisted conversations (`localStorage`) for shared workstations.
      forgetLocalHistory();
      leaving = true;
      window.location.assign(body.endSessionUrl ?? '/');
    },

    async handleUnauthorized() {
      // A 401 on a live session was the backend's, and the BFF has already renewed once: one more
      // attempt is the caller's. A 401 because the session is gone means signing in again.
      const current = await readSession().catch(() => null);
      if (current?.authenticated) return true;
      startLogin();
      return false;
    },
  };
}
