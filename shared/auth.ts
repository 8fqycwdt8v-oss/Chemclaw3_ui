/**
 * What the SPA and the BFF agree on about signing in, and nothing else.
 *
 * Under `AUTH_MODE=bff` the BFF owns the OIDC exchange and the tokens; the browser holds one
 * opaque session cookie it cannot read. These are the paths it navigates to, the header it adds to
 * every `/api` call so a cross-site request cannot ride the cookie, and the one shape the BFF
 * answers `GET /auth/session` with. No token appears in any of them.
 */

/** The BFF's sign-in routes. Navigations (`login`, `callback`) and fetches (`session`, `logout`). */
export const AUTH_PATHS = {
  login: '/auth/login',
  callback: '/auth/callback',
  session: '/auth/session',
  logout: '/auth/logout',
} as const;

/**
 * A request header no cross-origin page can send without a CORS preflight, which the BFF never
 * answers. Every `/api` call and `POST /auth/logout` carries it; the BFF refuses a state-changing
 * request without it. The value carries no secret.
 */
export const CSRF_HEADER = 'x-chemclaw-csrf';
export const CSRF_VALUE = '1';

/**
 * Appended to the page a sign-in returns to, so the SPA can tell "just came back from the identity
 * provider and still have no session" (a cookie that was not stored) from "never signed in", and
 * stop instead of redirecting again, for ever.
 */
export const SIGNED_IN_MARKER = 'signed_in';

/** Who is signed in, as the browser may know it. */
export interface AccountView {
  /** The identity provider's object id (`oid`), else `sub`. */
  id: string;
  username: string;
  name: string;
  roles: string[];
}

/** The body of `GET /auth/session`. */
export interface SessionView {
  authenticated: boolean;
  account?: AccountView;
}

/** The body of `POST /auth/logout`: where to send the browser to end the identity provider's session. */
export interface LogoutView {
  endSessionUrl: string | null;
}

const LONGEST_RETURN_TO = 512;

/**
 * A place on this origin a sign-in may return to, or `/`. Only a rooted path survives: printable
 * ASCII only (anything else cannot be written into a `Location` header, so it would fail after the
 * sign-in succeeded), no scheme, no authority (`//host`, `/\host`), nothing under `/auth/` or
 * `/api/` (a return into the sign-in routes is a loop, into the proxy a download the page never
 * asked for).
 */
export function safeReturnTo(raw: string | null | undefined): string {
  if (!raw || raw.length > LONGEST_RETURN_TO) return '/';
  if (!/^[\u0021-\u007e]+$/.test(raw) || raw.includes('\\')) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  const path = raw.split(/[?#]/, 1)[0] ?? '/';
  if (/^\/(auth|api)(\/|$)/.test(path)) return '/';
  return raw;
}
