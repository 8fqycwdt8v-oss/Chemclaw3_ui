/**
 * Cross-site request refusal for everything that carries the session cookie.
 *
 * `SameSite=Strict` is the first wall. These checks are the second, for a browser that mishandles
 * it and for same-site neighbours (a sibling subdomain is the same site): `Sec-Fetch-Site` where the
 * browser sends it, and for a state-changing method the `Origin` (when present it must be this
 * app's) plus a header no cross-origin page can set without a preflight this process never
 * answers. Safe methods are not state-changing here: the proxy only reads on them.
 */

import type { IncomingMessage } from 'node:http';
import { CSRF_HEADER, CSRF_VALUE } from '../../shared/auth.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Why this request must be refused as cross-site, or `null` to let it through. `appOrigin` is the
 * configured origin, not anything read from the request.
 */
export function csrfRefusal(req: IncomingMessage, appOrigin: string): string | null {
  const site = req.headers['sec-fetch-site'];
  // `none` is a navigation the user typed; `same-origin` is this app. `same-site` is refused: a
  // sibling host or the sandbox listener has no business calling the API.
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    return `Sec-Fetch-Site: ${site}`;
  }
  if (SAFE_METHODS.has(req.method ?? 'GET')) return null;

  const origin = req.headers.origin;
  if (origin !== undefined && origin !== appOrigin) return 'Origin does not match the app';
  if (req.headers[CSRF_HEADER] !== CSRF_VALUE) return `missing ${CSRF_HEADER} header`;
  return null;
}
