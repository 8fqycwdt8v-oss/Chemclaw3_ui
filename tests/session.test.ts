/**
 * The sealed session: the primitive everything in BFF custody rests on.
 *
 * If `unseal` can be made to accept something `seal` did not produce, an attacker writes their own
 * session cookie and is any user they like. So these lean hard on the negative cases — tamper,
 * wrong key, truncation, cross-purpose reuse — rather than on the round trip, which is the easy
 * half.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  csrfMatches,
  newCsrfToken,
  resetKeyCache,
  seal,
  sealLogin,
  unseal,
  unsealLogin,
  type Session,
} from '../server/auth/session.ts';
import { createPkce } from '../server/auth/oidc.ts';

const SECRET = 'a-secret-long-enough-to-be-plausible-0123456789';
const OTHER = 'a-different-secret-also-long-enough-0123456789';

const session = (over: Partial<Session> = {}): Session => ({
  accessToken: 'eyJ.access.token',
  refreshToken: '0.AXkA.refresh',
  expiresAt: 1_760_000_000_000,
  oid: '11111111-2222-3333-4444-555555555555',
  upn: 'chemist@example.com',
  name: 'A Chemist',
  csrf: 'csrf-token-value',
  ...over,
});

beforeEach(() => {
  resetKeyCache();
});

describe('seal and unseal', () => {
  it('round-trips every field', () => {
    expect(unseal(seal(session(), SECRET), SECRET)).toEqual(session());
  });

  it('produces a different ciphertext each time, so two sessions are not comparable', () => {
    // A deterministic seal would let anyone with a cookie tell whether two users hold the same
    // token, and would leak that a session was unchanged across a refresh.
    expect(seal(session(), SECRET)).not.toBe(seal(session(), SECRET));
  });

  it('refuses a session sealed under a different secret', () => {
    const sealed = seal(session(), SECRET);
    resetKeyCache();
    expect(unseal(sealed, OTHER)).toBeNull();
  });

  it('refuses a tampered ciphertext rather than decrypting it to something', () => {
    const sealed = seal(session(), SECRET);
    const [iv, tag, data] = sealed.split('.') as [string, string, string];
    // Flip one character of the ciphertext. GCM's auth tag is what makes this fail closed; without
    // it, CTR-mode decryption would happily produce corrupted plaintext.
    const flipped = `${data.slice(0, -1)}${data.endsWith('A') ? 'B' : 'A'}`;
    expect(unseal(`${iv}.${tag}.${flipped}`, SECRET)).toBeNull();
  });

  it('refuses a truncated cookie', () => {
    const sealed = seal(session(), SECRET);
    expect(unseal(sealed.slice(0, sealed.length - 10), SECRET)).toBeNull();
    expect(unseal(sealed.split('.').slice(0, 2).join('.'), SECRET)).toBeNull();
  });

  it('refuses garbage without throwing', () => {
    for (const value of ['', '.', 'a.b.c', 'not-sealed-at-all', '..', 'a.b.c.d']) {
      expect(unseal(value, SECRET)).toBeNull();
    }
  });

  it('refuses a payload missing an identity', () => {
    // An empty `oid` is not an identity, and a shape check that let it through would attribute
    // every such request to the same empty principal.
    expect(unseal(seal(session({ oid: '' }), SECRET), SECRET)).toBeNull();
    expect(unseal(seal(session({ csrf: '' }), SECRET), SECRET)).toBeNull();
  });
});

describe('purpose separation', () => {
  it('will not open a login state as a session, or the reverse', () => {
    // Both are sealed under the same key on the same origin, so without the AAD binding the only
    // thing keeping them apart would be the cookie name — which the client chooses.
    const login = sealLogin(
      { verifier: 'v', state: 's', nonce: 'n', returnTo: '/', expiresAt: Date.now() + 60_000 },
      SECRET,
    );
    expect(unseal(login, SECRET)).toBeNull();
    expect(unsealLogin(seal(session(), SECRET), SECRET, Date.now())).toBeNull();
  });
});

describe('the derived-key cache', () => {
  it('does not hand a second secret the first secret’s key', () => {
    // The cache was keyed on nothing, so this test fails against that version: `seal(_, OTHER)`
    // would reuse the key derived from SECRET, and the two secrets would be interchangeable.
    const underFirst = seal(session(), SECRET);
    const underSecond = seal(session(), OTHER);
    expect(unseal(underSecond, SECRET)).toBeNull();
    expect(unseal(underFirst, OTHER)).toBeNull();
    expect(unseal(underSecond, OTHER)).toEqual(session());
  });
});

describe('the login state', () => {
  const login = (over: Record<string, unknown> = {}) => ({
    verifier: 'verifier-value',
    state: 'state-value',
    nonce: 'nonce-value',
    returnTo: '/chat',
    expiresAt: 2_000_000,
    ...over,
  });

  it('round-trips inside its window', () => {
    expect(unsealLogin(sealLogin(login(), SECRET), SECRET, 1_000_000)).toEqual(login());
  });

  it('refuses one whose window has closed', () => {
    // Otherwise an abandoned sign-in stays answerable for as long as the cookie survives.
    expect(unsealLogin(sealLogin(login(), SECRET), SECRET, 2_000_001)).toBeNull();
  });

  it('refuses one with no verifier, which would make PKCE decorative', () => {
    expect(unsealLogin(sealLogin(login({ verifier: '' }), SECRET), SECRET, 1)).toBeNull();
  });
});

describe('CSRF tokens', () => {
  it('matches a token against itself and nothing else', () => {
    const token = newCsrfToken();
    expect(csrfMatches(token, token)).toBe(true);
    expect(csrfMatches(token, newCsrfToken())).toBe(false);
  });

  it('returns false on a length mismatch instead of throwing', () => {
    // `timingSafeEqual` throws on unequal lengths, and an exception here would reach the request
    // handler as a 500 on what is simply a bad token.
    expect(csrfMatches('short', newCsrfToken())).toBe(false);
    expect(csrfMatches('', '')).toBe(false);
  });

  it('is long enough not to be guessable', () => {
    expect(newCsrfToken().length).toBeGreaterThanOrEqual(43);
    expect(newCsrfToken()).not.toBe(newCsrfToken());
  });
});

describe('PKCE', () => {
  it('derives an S256 challenge of the right shape', () => {
    const { verifier, challenge } = createPkce();
    // RFC 7636 sets the verifier at 43-128 characters and the S256 challenge at a base64url
    // SHA-256, which is always 43.
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toHaveLength(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toBe(verifier);
  });

  it('is different every time', () => {
    expect(createPkce().verifier).not.toBe(createPkce().verifier);
  });
});
