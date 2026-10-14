/**
 * The two cookies the sign-in sets, and the only code that reads or writes one.
 *
 * Both are host-only (`Path=/`, no `Domain`) and `HttpOnly`; both carry `Secure` and the `__Host-`
 * prefix exactly when `APP_ORIGIN` is https (`cfg.cookieSecure`). Values are random identifiers, so
 * parsing accepts nothing but the base64url alphabet and a forged or mangled value is simply
 * absent.
 */

import type { IncomingMessage } from 'node:http';

/** `SameSite=Strict` for the session; `Lax` only for the login binding (below). */
export type SameSite = 'Strict' | 'Lax';

const VALUE = /^[A-Za-z0-9_-]{16,128}$/;

/** One cookie's value from the request, or `''` when absent or malformed. */
export function readCookie(req: IncomingMessage, name: string): string {
  const header = req.headers.cookie;
  if (!header) return '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return VALUE.test(value) ? value : '';
  }
  return '';
}

export interface CookieOptions {
  secure: boolean;
  sameSite: SameSite;
  /** Lifetime in seconds; omitted for a session cookie. */
  maxAgeSeconds?: number;
}

/**
 * A `Set-Cookie` value. `SameSite=Strict` is the session's: the cookie is never sent on a request a
 * foreign site initiates. The login binding is `Lax` because the identity provider's redirect back
 * to `/auth/callback` is exactly such a request, and the binding must be present on it.
 */
export function setCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', `SameSite=${options.sameSite}`];
  if (options.secure) parts.push('Secure');
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  }
  return parts.join('; ');
}

/** A `Set-Cookie` that removes the cookie, with the attributes it was set with. */
export function clearCookie(name: string, options: Omit<CookieOptions, 'maxAgeSeconds'>): string {
  return setCookie(name, '', { ...options, maxAgeSeconds: 0 });
}
