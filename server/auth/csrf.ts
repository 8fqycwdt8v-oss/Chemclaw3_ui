/**
 * Cross-site request refusal for everything that carries the session cookie. `SameSite=Strict` is
 * the first wall; these are the second, for a browser that mishandles it and for same-site
 * neighbours (the sandbox host is one): `Sec-Fetch-Site` where sent, an `Origin` that is this app's
 * on a state-changing method, and `X-Chemclaw-Csrf`, which no other origin can set without a
 * preflight this process never answers. `/api` demands the header on every method, GET included —
 * some reads consume what they return, and a plain `<img src>` cannot send it.
 */

import type { IncomingMessage } from 'node:http';
import { CSRF_HEADER, CSRF_VALUE } from '../../shared/auth.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Why this request must be refused as cross-site, or `null` to let it through. `appOrigin` is the
 * configured origin, not anything read from the request.
 */
export function csrfRefusal(
  req: IncomingMessage,
  appOrigin: string,
  /** Whether a safe method must carry the header too (`/api`); `/auth/session` need not. */
  headerOnReads = true,
): string | null {
  const site = req.headers['sec-fetch-site'];
  // `none` is a navigation the user typed; `same-origin` is this app. `same-site` is refused: a
  // sibling host or the sandbox listener has no business calling the API.
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    return `Sec-Fetch-Site: ${site}`;
  }
  const safe = SAFE_METHODS.has(req.method ?? 'GET');
  if (safe && !headerOnReads) return null;

  const origin = req.headers.origin;
  if (!safe && origin !== undefined && origin !== appOrigin) {
    return 'Origin does not match the app';
  }
  if (req.headers[CSRF_HEADER] !== CSRF_VALUE) return `missing ${CSRF_HEADER} header`;
  return null;
}
