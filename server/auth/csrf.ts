/**
 * Cross-site request forgery defence, which this app needs for the first time.
 *
 * Until BFF custody there were no cookies on this origin at all, so a cross-site request carried no
 * credentials and there was nothing to forge — `proxy.ts` says as much in its own docstring. Moving
 * the token into a cookie is what creates the surface, and it is the main cost of the change. It is
 * worth stating plainly rather than burying: the browser now attaches the user's session to *any*
 * request to this origin, including one initiated by a page they did not write.
 *
 * Three independent checks, because each fails differently:
 *
 *  1. `SameSite=Lax` on the session cookie (in `cookies.ts`). The browser withholds it on cross-site
 *     POST/PUT/DELETE outright. Strong, and free — but it is `Lax` rather than `Strict` for the
 *     OAuth callback's sake, and browser support for the *default* has historically wobbled.
 *  2. An `Origin` check. Present on every state-changing request from every current browser and
 *     not forgeable by page script. This is the workhorse.
 *  3. A double-submit token the SPA echoes in a header. Catches the case where an attacker somehow
 *     gets a request through with cookies attached but cannot read them — which is the whole shape
 *     of a CSRF, since same-origin policy stops them reading our responses.
 *
 * Safe methods are exempt. `GET` and `HEAD` must not change state upstream, and the backend's route
 * table is checked against that assumption by `scripts/check-contract.mjs`.
 */

import type { IncomingMessage } from 'node:http';
import { csrfMatches, type Session } from './session.ts';
import { firstHeader, selfOrigin } from '../httpUtil.ts';

/** The header the SPA echoes its CSRF token in. Mirrored in `src/api/http.ts`. */
export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type CsrfVerdict = { ok: true } | { ok: false; reason: string };

const ok: CsrfVerdict = { ok: true };

/**
 * The origin a request claims to come from, normalised.
 *
 * `Origin` is preferred; `Referer` is the fallback for the handful of cases that still omit it, and
 * only its origin component is used — the path would leak, and is not what is being compared.
 */
function claimedOrigin(req: IncomingMessage): string | null {
  const origin = firstHeader(req.headers.origin);
  // Literally the four characters "null": what a sandboxed iframe or a `data:` document sends. It
  // is an origin that names no site, so it can never match ours, but it must not be treated as
  // *absent* either — absent has a fallback path and this must not reach it.
  if (origin) return origin;
  const referer = firstHeader(req.headers.referer);
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

/**
 * Whether a state-changing request may proceed.
 *
 * `session` is the *sealed* session's CSRF token, not the readable cookie's. That is stronger than
 * textbook double-submit: the readable `ccx` cookie is only the delivery mechanism for the SPA, and
 * an attacker who could write cookies on this origin (a sibling subdomain, say — which `__Host-`
 * already blocks) still could not make the sealed copy agree, because they cannot seal one.
 */
export function checkCsrf(req: IncomingMessage, session: Session | null): CsrfVerdict {
  const method = req.method ?? 'GET';
  if (SAFE_METHODS.has(method)) return ok;

  // No session means no credentials are attached, so there is nothing to forge the use of. Letting
  // it through keeps the failure honest: the backend answers 401, rather than this layer reporting
  // a CSRF problem to someone who is simply not signed in.
  if (session === null) return ok;

  const expected = selfOrigin(req);
  const claimed = claimedOrigin(req);
  if (claimed === null) {
    return {
      ok: false,
      reason:
        'no Origin or Referer header on a state-changing request. Every current browser sends ' +
        'one; a request without either is refused rather than assumed same-origin.',
    };
  }
  if (claimed !== expected) {
    return { ok: false, reason: `Origin ${claimed} does not match ${expected}` };
  }

  const presented = firstHeader(req.headers[CSRF_HEADER]);
  if (!presented) {
    return { ok: false, reason: `missing ${CSRF_HEADER} header` };
  }
  if (!csrfMatches(presented, session.csrf)) {
    return { ok: false, reason: `${CSRF_HEADER} does not match this session` };
  }
  return ok;
}
