/**
 * The cookie layer, and specifically the chunking a sealed session needs.
 *
 * The failure this file is written against is the quiet one: a session that is written truncated,
 * unseals to `null` on the next request, and presents to the user as "sign-in randomly does not
 * stick". So the ceiling must throw, a shrinking session must not leave a stale tail, and a gap in
 * the chunk sequence must stop the read rather than splice across it.
 */

import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  clearAuthCookies,
  cookieLimits,
  csrfCookieName,
  parseCookies,
  readSessionCookie,
  writeCsrfCookie,
  writeSessionCookie,
} from '../server/auth/cookies.ts';

/** Just enough of a ServerResponse for the header staging these functions do. */
type FakeRes = ServerResponse & { cookies: string[] };

function fakeRes(): FakeRes {
  const headers = new Map<string, string | string[]>();
  const res = {
    cookies: [] as string[],
    getHeader: (name: string) => headers.get(name),
    setHeader(name: string, value: string | string[]) {
      headers.set(name, value);
      res.cookies = Array.isArray(value) ? value : [String(value)];
    },
  };
  return res as unknown as FakeRes;
}

const fakeReq = (cookie: string): IncomingMessage =>
  ({ headers: { cookie } }) as unknown as IncomingMessage;

/** Turn staged `Set-Cookie` lines back into what a browser would send next time. */
const roundTrip = (cookies: string[]): IncomingMessage =>
  fakeReq(
    cookies
      .filter((c) => !c.includes('Max-Age=0'))
      .map((c) => c.split(';')[0])
      .join('; '),
  );

const attributes = (line: string): string[] =>
  line
    .split(';')
    .slice(1)
    .map((p) => p.trim());

describe('attributes', () => {
  it('marks the session httpOnly, Secure and __Host- prefixed over HTTPS', () => {
    const res = fakeRes();
    writeSessionCookie(res, 'sealed-value', { secure: true });
    const first = res.cookies[0]!;
    expect(first.startsWith('__Host-ccs0=')).toBe(true);
    expect(attributes(first)).toContain('HttpOnly');
    expect(attributes(first)).toContain('Secure');
    expect(attributes(first)).toContain('Path=/');
    // `__Host-` is only honoured with Path=/ and no Domain; a Domain would let a sibling
    // subdomain overwrite the session.
    expect(first).not.toMatch(/Domain=/);
  });

  it('drops the prefix and Secure over plain HTTP, which a browser would otherwise reject', () => {
    const res = fakeRes();
    writeSessionCookie(res, 'sealed-value', { secure: false });
    expect(res.cookies[0]!.startsWith('ccs0=')).toBe(true);
    expect(attributes(res.cookies[0]!)).not.toContain('Secure');
  });

  it('uses SameSite=Lax, not Strict, or sign-in could never complete', () => {
    // Strict withholds the cookie on a top-level cross-site navigation — which is exactly the
    // return leg of the OAuth redirect, so `/auth/callback` would run with no login state.
    const res = fakeRes();
    writeSessionCookie(res, 'sealed', { secure: true });
    expect(attributes(res.cookies[0]!)).toContain('SameSite=Lax');
  });

  it('leaves the CSRF cookie readable by script, which is what double-submit needs', () => {
    const res = fakeRes();
    writeCsrfCookie(res, 'token', { secure: true });
    const line = res.cookies.find((c) => c.startsWith(csrfCookieName(true)))!;
    expect(attributes(line)).not.toContain('HttpOnly');
    expect(attributes(line)).toContain('Secure');
  });
});

describe('chunking', () => {
  const big = (n: number): string => 'x'.repeat(n);

  it('splits a large session and reassembles it exactly', () => {
    const value = big(cookieLimits.MAX_CHUNK_BYTES * 2 + 17);
    const res = fakeRes();
    writeSessionCookie(res, value, { secure: true });
    expect(res.cookies.filter((c) => !c.includes('Max-Age=0'))).toHaveLength(3);
    expect(readSessionCookie(roundTrip(res.cookies), true)).toBe(value);
  });

  it('round-trips a value needing exactly one chunk', () => {
    const res = fakeRes();
    writeSessionCookie(res, 'small', { secure: true });
    expect(readSessionCookie(roundTrip(res.cookies), true)).toBe('small');
  });

  it('expires the chunks a shrinking session no longer needs', () => {
    // Without this, a long session followed by a short one leaves `ccs1` behind, the reader
    // splices it onto the new value, and the result unseals to nothing.
    const res = fakeRes();
    writeSessionCookie(res, 'now-short', { secure: true });
    const cleared = res.cookies.filter((c) => c.includes('Max-Age=0'));
    expect(cleared).toHaveLength(cookieLimits.MAX_CHUNKS - 1);
    expect(cleared.some((c) => c.startsWith('__Host-ccs1='))).toBe(true);
  });

  it('throws rather than truncating a session that will not fit', () => {
    const res = fakeRes();
    const tooBig = big(cookieLimits.MAX_CHUNK_BYTES * cookieLimits.MAX_CHUNKS + 1);
    expect(() => writeSessionCookie(res, tooBig, { secure: true })).toThrow(/too large/);
  });

  it('stops at a gap instead of splicing across it', () => {
    // A partially-delivered or partially-cleared cookie set. Concatenating `ccs0` and `ccs2` would
    // produce a value that fails to unseal anyway, but at a point much further from the cause.
    const req = fakeReq('__Host-ccs0=aaa; __Host-ccs2=ccc');
    expect(readSessionCookie(req, true)).toBe('aaa');
  });

  it('returns null when there is no session at all', () => {
    expect(readSessionCookie(fakeReq(''), true)).toBeNull();
    expect(readSessionCookie(fakeReq('other=1'), true)).toBeNull();
  });
});

describe('parsing', () => {
  it('reads a value containing an = sign', () => {
    // base64 padding is `=`, and splitting on every `=` would truncate a sealed value.
    expect(parseCookies(fakeReq('a=b=c==')).get('a')).toBe('b=c==');
  });

  it('keeps a malformed percent-escape rather than failing the whole header', () => {
    const cookies = parseCookies(fakeReq('bad=%E0%A4%A; good=fine'));
    expect(cookies.get('good')).toBe('fine');
    expect(cookies.get('bad')).toBe('%E0%A4%A');
  });

  it('ignores a segment with no value', () => {
    expect(parseCookies(fakeReq('novalue; a=1')).get('a')).toBe('1');
  });
});

describe('clearing', () => {
  it('expires every chunk, the CSRF token and any half-finished login', () => {
    const res = fakeRes();
    clearAuthCookies(res, { secure: true });
    expect(res.cookies.every((c) => c.includes('Max-Age=0'))).toBe(true);
    expect(res.cookies).toHaveLength(cookieLimits.MAX_CHUNKS + 2);
    expect(res.cookies.some((c) => c.startsWith('__Host-ccx='))).toBe(true);
    expect(res.cookies.some((c) => c.startsWith('__Host-ccl='))).toBe(true);
  });
});
