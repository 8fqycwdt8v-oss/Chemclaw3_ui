/**
 * The headers and credentials every call to the BFF carries, in one place.
 *
 * There are four `fetch` call sites in this app — `client.ts`, `streamTurn.ts`, `useJobFeed.ts`
 * and the readiness probe in `TopBar.tsx` — and under BFF custody every one of them needs the same
 * two things: the cookie, and the CSRF token echoed back in a header. Spreading that across four
 * files is how one of them ends up without it, and the one that ends up without it is the one that
 * breaks in production a month later.
 */

/** Must match `CSRF_HEADER` in `server/auth/csrf.ts`. */
export const CSRF_HEADER = 'x-csrf-token';

/**
 * The BFF writes this readable alongside the sealed, httpOnly session.
 *
 * Two names because the `__Host-` prefix requires `Secure`, which a browser will not accept over
 * plain HTTP — so a local development deployment gets the bare name. Reading both is simpler and
 * more robust than teaching the client which scheme it is on.
 */
const CSRF_COOKIE_NAMES = ['__Host-ccx', 'ccx'];

export function csrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (!CSRF_COOKIE_NAMES.includes(part.slice(0, eq).trim())) continue;
    const value = decodeURIComponent(part.slice(eq + 1).trim());
    if (value !== '') return value;
  }
  return null;
}

/**
 * The credentials headers for a request, whichever custody mode is in force.
 *
 * The two are mutually exclusive in practice and the code does not need to know which mode it is
 * in: under `bff` the token getter resolves to `null` by design and the cookie is present, under
 * `msal-spa` there is a token and no cookie. Emitting whichever exists keeps the call sites free
 * of a mode check.
 *
 * The CSRF header goes on every request including the safe ones. The server only checks it on
 * state-changing methods, but sending it unconditionally means a route that becomes non-safe later
 * does not silently start failing.
 */
export function credentialHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const csrf = csrfToken();
  if (csrf) headers[CSRF_HEADER] = csrf;
  return headers;
}

/**
 * Explicit, rather than relying on `fetch`'s default.
 *
 * The default *is* `same-origin` in every current browser, so this changes no behaviour today. It
 * is written down because the session now rides on a cookie: a future call site that sets
 * `credentials: 'omit'` while reaching for some other option would silently unauthenticate itself,
 * and a reader comparing these call sites should be able to see the intent rather than infer it.
 */
export const CREDENTIALS: RequestCredentials = 'same-origin';
