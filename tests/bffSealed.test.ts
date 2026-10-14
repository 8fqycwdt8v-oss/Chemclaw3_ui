// @vitest-environment node

/**
 * The sealed sign-in cookie, without a server: what authenticates and what it refuses.
 */

import { describe, expect, it } from 'vitest';
import { deriveKey, seal, tagOf, unseal } from '../server/auth/sealed.ts';
import type { LoginState } from '../server/auth/sealed.ts';

const login = (over: Partial<LoginState> = {}): LoginState => ({
  state: 's'.repeat(43),
  nonce: 'n'.repeat(43),
  verifier: 'v'.repeat(43),
  returnTo: '/open/abc?x=1',
  expiresAt: 10_000,
  ...over,
});

const key = deriveKey('a-configured-secret-of-at-least-32-chars');

describe('sealing a sign-in', () => {
  it('round-trips under the same key and tag', () => {
    const sealed = seal(login(), key);
    expect(unseal(sealed, tagOf(login().state), key, 5_000)).toEqual(login());
  });

  it('does not show what it holds', () => {
    const sealed = Buffer.from(seal(login(), key), 'base64url').toString('latin1');
    for (const secret of ['v'.repeat(43), 'n'.repeat(43), '/open/abc']) {
      expect(sealed).not.toContain(secret);
    }
  });

  it('is refused when it is changed anywhere, including the tag and the nonce bytes', () => {
    const sealed = seal(login(), key);
    const raw = Buffer.from(sealed, 'base64url');
    for (const at of [0, 12, 20, raw.length - 1]) {
      const damaged = Buffer.from(raw);
      damaged[at] = (damaged[at] ?? 0) ^ 1;
      expect(
        unseal(damaged.toString('base64url'), tagOf(login().state), key, 5_000),
      ).toBeUndefined();
    }
    expect(unseal(sealed.slice(0, -4), tagOf(login().state), key, 5_000)).toBeUndefined();
    expect(unseal('', tagOf(login().state), key, 5_000)).toBeUndefined();
  });

  it('is refused under another key (another process with a random key, or a rotated one)', () => {
    const sealed = seal(login(), key);
    expect(unseal(sealed, tagOf(login().state), deriveKey(''), 5_000)).toBeUndefined();
    expect(
      unseal(
        sealed,
        tagOf(login().state),
        deriveKey('another-secret-of-at-least-32-characters'),
        5_000,
      ),
    ).toBeUndefined();
  });

  it('is refused under another tag, so it cannot be moved to another cookie name', () => {
    const sealed = seal(login(), key);
    expect(unseal(sealed, tagOf('another-state'), key, 5_000)).toBeUndefined();
  });

  it('is refused once expired', () => {
    const sealed = seal(login(), key);
    expect(unseal(sealed, tagOf(login().state), key, 10_001)).toBeUndefined();
    expect(unseal(sealed, tagOf(login().state), key, 9_999)).toBeDefined();
  });

  it('derives the same key from the same secret, and a fresh random one when there is none', () => {
    expect(deriveKey('x'.repeat(40)).equals(deriveKey('x'.repeat(40)))).toBe(true);
    expect(deriveKey('').equals(deriveKey(''))).toBe(false);
    expect(key).toHaveLength(32);
  });

  it('names a cookie with a tag that is short and does not reveal the state', () => {
    const tag = tagOf('a-state');
    expect(tag).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(tag).not.toContain('a-state');
  });
});
