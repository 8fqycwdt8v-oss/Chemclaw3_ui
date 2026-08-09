/**
 * Cookie reading and writing, including the chunking a sealed session needs.
 *
 * The size problem is real and is the main cost of holding tokens in a cookie rather than a server
 * store. An Entra access token runs 1–2 KB and a refresh token around 1 KB; sealed, JSON-wrapped
 * and base64url'd, a session can land near or above the ~4 KB per-cookie limit browsers enforce.
 * So a sealed value is split across numbered cookies and reassembled on read.
 *
 * There is a hard ceiling on the number of chunks, and exceeding it is an error rather than a
 * truncation. A silently truncated session would unseal to `null` and log the user out on their
 * next request with no explanation — the failure would look like "sign-in randomly does not
 * stick", which is close to undiagnosable from a bug report.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * `__Host-` prefix: the browser refuses to accept such a cookie unless it is `Secure`, has no
 * `Domain`, and has `Path=/`. That makes it impossible for a sibling subdomain to set or overwrite
 * it, which is the attack this app would otherwise have no defence against.
 *
 * Dropped in plain-HTTP local development, where `Secure` cannot be satisfied and the browser
 * would reject the cookie outright.
 */
const HOST_PREFIX = '__Host-';
const SESSION_BASE = 'ccs';
const CSRF_BASE = 'ccx';
const LOGIN_BASE = 'ccl';

/** Conservative: real limits are ~4096 bytes for the whole `name=value` pair. */
const MAX_CHUNK_BYTES = 3500;
const MAX_CHUNKS = 4;

export interface CookieOptions {
  /** False only for plain-HTTP local development, where `Secure` cookies are rejected. */
  secure: boolean;
  /** Seconds. Omitted for a session cookie that should die with the browser. */
  maxAge?: number;
}

const sessionName = (secure: boolean, index: number): string =>
  `${secure ? HOST_PREFIX : ''}${SESSION_BASE}${index}`;

export const csrfCookieName = (secure: boolean): string =>
  `${secure ? HOST_PREFIX : ''}${CSRF_BASE}`;

export const loginCookieName = (secure: boolean): string =>
  `${secure ? HOST_PREFIX : ''}${LOGIN_BASE}`;

/** Parse a Cookie header into a map. Values are percent-decoded, names are not. */
export function parseCookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name === '') continue;
    try {
      out.set(name, decodeURIComponent(value));
    } catch {
      // A malformed escape means a cookie we did not write. Skip it rather than failing the
      // request: other cookies on the same header may be perfectly good.
      out.set(name, value);
    }
  }
  return out;
}

function serialise(
  name: string,
  value: string,
  options: CookieOptions & { httpOnly: boolean },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/'];
  // Lax, NOT Strict. Strict withholds the cookie on a top-level cross-site navigation, which is
  // exactly what the return leg of the OAuth redirect is — so a Strict session cookie is not
  // present when `/auth/callback` runs, and sign-in can never complete.
  parts.push('SameSite=Lax');
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  return parts.join('; ');
}

/** Append a `Set-Cookie`, preserving any already staged on this response. */
function appendCookie(res: ServerResponse, cookie: string): void {
  const existing = res.getHeader('set-cookie');
  const list = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
  res.setHeader('set-cookie', [...list, cookie]);
}

/**
 * Write a sealed session across as many chunks as it needs.
 *
 * Also clears any higher-numbered chunk left by a previous, larger session — otherwise a shrinking
 * session leaves a stale tail that the reader would splice onto the new value and fail to unseal.
 */
export function writeSessionCookie(
  res: ServerResponse,
  sealed: string,
  options: CookieOptions,
): void {
  const chunks: string[] = [];
  for (let i = 0; i < sealed.length; i += MAX_CHUNK_BYTES) {
    chunks.push(sealed.slice(i, i + MAX_CHUNK_BYTES));
  }
  if (chunks.length > MAX_CHUNKS) {
    // Loud, not silent. See the module docstring: a truncated session is undiagnosable from the
    // outside, so this refuses instead.
    throw new Error(
      `session too large to store in cookies (${sealed.length} bytes, max ` +
        `${MAX_CHUNK_BYTES * MAX_CHUNKS}). The identity provider is returning unusually large ` +
        'tokens; a server-side session store would be needed.',
    );
  }

  chunks.forEach((chunk, index) => {
    appendCookie(
      res,
      serialise(sessionName(options.secure, index), chunk, { ...options, httpOnly: true }),
    );
  });
  // Expire the chunks this session no longer needs.
  for (let index = chunks.length; index < MAX_CHUNKS; index += 1) {
    appendCookie(
      res,
      serialise(sessionName(options.secure, index), '', { ...options, httpOnly: true, maxAge: 0 }),
    );
  }
}

/** Reassemble a sealed session from its chunks, or `null` if the first one is missing. */
export function readSessionCookie(req: IncomingMessage, secure: boolean): string | null {
  const cookies = parseCookies(req);
  let value = '';
  for (let index = 0; index < MAX_CHUNKS; index += 1) {
    const chunk = cookies.get(sessionName(secure, index));
    // Chunks are contiguous from 0. A gap means a partially-cleared or partially-delivered cookie
    // set, and splicing across it would produce a value that unseals to nothing anyway.
    if (chunk === undefined || chunk === '') break;
    value += chunk;
  }
  return value === '' ? null : value;
}

/**
 * The CSRF cookie — readable by JavaScript, unlike the session.
 *
 * That is the double-submit pattern: the SPA reads this and echoes it in a header, and the server
 * checks the two match. An attacker on another origin can cause the browser to *send* the cookie
 * but cannot read it, so they cannot produce the matching header.
 */
export function writeCsrfCookie(res: ServerResponse, token: string, options: CookieOptions): void {
  appendCookie(
    res,
    serialise(csrfCookieName(options.secure), token, { ...options, httpOnly: false }),
  );
}

/**
 * The half-finished login, held only between `/auth/login` and `/auth/callback`.
 *
 * httpOnly — nothing in the browser has any business reading the PKCE verifier — and short-lived,
 * because a login the user abandoned should stop being answerable rather than sit there for the
 * rest of the browser session.
 */
export function writeLoginCookie(
  res: ServerResponse,
  sealed: string,
  options: CookieOptions,
): void {
  appendCookie(
    res,
    serialise(loginCookieName(options.secure), sealed, { ...options, httpOnly: true }),
  );
}

export const readLoginCookie = (req: IncomingMessage, secure: boolean): string | null =>
  parseCookies(req).get(loginCookieName(secure)) ?? null;

export function clearLoginCookie(res: ServerResponse, options: CookieOptions): void {
  appendCookie(
    res,
    serialise(loginCookieName(options.secure), '', { ...options, httpOnly: true, maxAge: 0 }),
  );
}

/** Clear every cookie this module writes. */
export function clearAuthCookies(res: ServerResponse, options: CookieOptions): void {
  for (let index = 0; index < MAX_CHUNKS; index += 1) {
    appendCookie(
      res,
      serialise(sessionName(options.secure, index), '', { ...options, httpOnly: true, maxAge: 0 }),
    );
  }
  appendCookie(
    res,
    serialise(csrfCookieName(options.secure), '', { ...options, httpOnly: false, maxAge: 0 }),
  );
  clearLoginCookie(res, options);
}

export const cookieLimits = { MAX_CHUNK_BYTES, MAX_CHUNKS };
