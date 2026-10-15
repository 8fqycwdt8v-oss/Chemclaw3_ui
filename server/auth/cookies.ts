/**
 * The cookies the sign-in sets (the session; a sealed one per sign-in in progress), and the only
 * code that reads or writes one.
 *
 * All are host-only (`Path=/`, no `Domain`) and `HttpOnly`; all carry `Secure` and the `__Host-`
 * prefix exactly when `APP_ORIGIN` is https (`cfg.cookieSecure`). Values are random identifiers, so
 * parsing accepts nothing but the base64url alphabet and a forged or mangled value is simply
 * absent.
 */

import type { IncomingMessage } from 'node:http';

/** `SameSite=Strict` for the session; `Lax` only for the login binding (below). */
export type SameSite = 'Strict' | 'Lax';

const VALUE = /^[A-Za-z0-9_-]{16,128}$/;
/** A sealed value (`sealed.ts`) is longer: base64url, bounded so a huge cookie is never parsed. */
const SEALED_VALUE = /^[A-Za-z0-9_-]{16,2048}$/;

function raw(req: IncomingMessage, name: string): string {
  const header = req.headers.cookie;
  if (!header) return '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return '';
}

/** One cookie's value from the request, or `''` when absent or malformed. */
export function readCookie(req: IncomingMessage, name: string): string {
  const value = raw(req, name);
  return VALUE.test(value) ? value : '';
}

/** As `readCookie`, for a sealed value. */
export function readSealedCookie(req: IncomingMessage, name: string): string {
  const value = raw(req, name);
  return SEALED_VALUE.test(value) ? value : '';
}

/** The names of every cookie on the request that starts with `prefix`. */
export function cookieNames(req: IncomingMessage, prefix: string): string[] {
  const header = req.headers.cookie;
  if (!header) return [];
  return header
    .split(';')
    .map((part) => part.slice(0, Math.max(0, part.indexOf('='))).trim())
    .filter((name) => name.startsWith(prefix));
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
