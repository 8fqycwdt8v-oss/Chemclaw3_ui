/**
 * A sign-in in progress, sealed into a cookie so the server keeps nothing for it.
 *
 * AES-256-GCM under a key derived from `SESSION_KEY` (or random per process). The sealed value
 * carries the state, nonce, PKCE verifier, return path and an expiry; the cookie's name carries a
 * tag of the state, and that tag is the AAD, so a value cannot be moved to another name. Tampering
 * or a wrong key fails authentication; an expired value is refused.
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

export interface LoginState {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  /** Epoch ms. */
  expiresAt: number;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A 32-byte key from the configured secret, or a random one when none is configured. */
export function deriveKey(secret: string): Buffer {
  if (!secret) return randomBytes(32);
  return Buffer.from(hkdfSync('sha256', secret, 'chemclaw-ui', 'login-cookie-v1', 32));
}

/** The short tag of a state that names its cookie: not secret, not reversible, 22 characters. */
export const tagOf = (state: string): string =>
  createHash('sha256').update(state).digest().subarray(0, 16).toString('base64url');

export function seal(login: LoginState, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(tagOf(login.state)));
  const body = Buffer.concat([cipher.update(JSON.stringify(login), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** The sealed login for a state's tag, or `undefined` if forged, damaged, moved or expired. */
export function unseal(
  value: string,
  tag: string,
  key: Buffer,
  now: number = Date.now(),
): LoginState | undefined {
  try {
    const raw = Buffer.from(value, 'base64url');
    if (raw.length <= IV_BYTES + TAG_BYTES) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(tag));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const plain = Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]);
    const login = JSON.parse(plain.toString('utf8')) as Partial<LoginState>;
    if (
      typeof login.state !== 'string' ||
      typeof login.nonce !== 'string' ||
      typeof login.verifier !== 'string' ||
      typeof login.returnTo !== 'string' ||
      typeof login.expiresAt !== 'number'
    ) {
      return undefined;
    }
    if (login.expiresAt < now || tagOf(login.state) !== tag) return undefined;
    return login as LoginState;
  } catch {
    return undefined;
  }
}
