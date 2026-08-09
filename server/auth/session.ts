/**
 * The sealed session cookie: how the BFF holds a token the browser never sees.
 *
 * AES-256-GCM over a JSON payload, keyed by `SESSION_SECRET`. Stateless by choice — the tokens
 * live in the cookie rather than in a server-side map — which is what lets this survive a restart
 * and work across replicas with no new infrastructure. The cost is size, handled by chunking
 * below, and revocation: a sealed cookie is valid until it expires, so logout clears the cookie
 * rather than invalidating a record.
 *
 * GCM rather than CBC+HMAC because it authenticates as well as encrypts, in one pass, from
 * `node:crypto` with no dependency. The IV is random per seal and stored alongside the ciphertext;
 * the auth tag is what makes a tampered cookie fail closed rather than decrypt to garbage.
 */

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** What the BFF keeps about a signed-in user. None of it is ever sent to the browser. */
export interface Session {
  /** The Entra access token for the Chemclaw API. */
  accessToken: string;
  /** Used to mint a new access token without another round trip through the user. */
  refreshToken: string;
  /** Epoch ms. Refresh is attempted before this, not after a 401. */
  expiresAt: number;
  /** Identity, for `/auth/me` and for logging. Not authorization — the backend decides that. */
  oid: string;
  upn: string;
  name: string;
  /** Bound to the CSRF token issued alongside this session. */
  csrf: string;
}

/**
 * The half-finished login: what `/auth/login` has to remember until `/auth/callback` runs.
 *
 * Sealed into its own short-lived cookie rather than kept in a server map, for the same reason the
 * session is: no shared state, so a login started on one replica can complete on another.
 */
export interface LoginState {
  /** The PKCE verifier. Never leaves this process except sealed. */
  verifier: string;
  /** Echoed by the identity provider and compared on return — the CSRF defence for the login leg. */
  state: string;
  /** Bound into the id_token, so a token minted for another login cannot be replayed into this one. */
  nonce: string;
  /** Where to send the browser afterwards. Validated as a same-origin path before it is used. */
  returnTo: string;
  /** Epoch ms. A login that was never completed should not stay answerable indefinitely. */
  expiresAt: number;
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the size GCM is defined for
const TAG_BYTES = 16;

/**
 * The encryption key, derived from the configured secret rather than used raw.
 *
 * HKDF because `SESSION_SECRET` is an operator-supplied string of unknown length and entropy
 * distribution, and AES-256 needs exactly 32 bytes. The `info` label domain-separates this key
 * from anything else the same secret might one day be used for.
 *
 * The cache is keyed by the secret it was derived from. A cache that ignored the secret would
 * return the first key forever, so a second seal under a different secret would silently produce a
 * cookie the first secret could open — which is the whole property this module exists to provide,
 * inverted. Tests change secrets between cases, and would have been the only thing to notice.
 */
let cachedKey: { secret: string; key: Buffer } | null = null;
function key(secret: string): Buffer {
  if (cachedKey === null || cachedKey.secret !== secret) {
    cachedKey = {
      secret,
      key: Buffer.from(hkdfSync('sha256', secret, 'chemclaw-session-v1', 'aes-256-gcm', 32)),
    };
  }
  return cachedKey.key;
}

/** Drop the derived key. Only tests need this; correctness does not depend on it. */
export function resetKeyCache(): void {
  cachedKey = null;
}

/**
 * Seal a value into an opaque, tamper-evident string.
 *
 * Layout: `iv.tag.ciphertext`, each base64url. Split rather than concatenated so a truncated
 * cookie fails at the parse rather than producing a wrong-length buffer that GCM then rejects with
 * a less obvious error.
 *
 * `purpose` is mixed into GCM's additional authenticated data, so a sealed login state cannot be
 * presented as a session or vice versa. Both live on the same origin under the same key; without
 * this, the only thing keeping them apart would be the cookie name, which the client controls.
 */
function sealValue(value: unknown, secret: string, purpose: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(secret), iv);
  cipher.setAAD(Buffer.from(purpose, 'utf8'));
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Open a sealed value, or `null` if it is not one we sealed for this purpose.
 *
 * Every failure — wrong key, wrong purpose, tampered ciphertext, truncated cookie, malformed JSON
 * — returns `null` rather than throwing. A caller that cannot tell "no session" from "a session I
 * could not read" would have to guess, and the safe guess is the same in both cases: treat the
 * request as unauthenticated.
 */
function unsealValue(value: string, secret: string, purpose: string): unknown {
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [ivPart, tagPart, dataPart] = parts as [string, string, string];

  try {
    const iv = Buffer.from(ivPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');
    const ciphertext = Buffer.from(dataPart, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;

    const decipher = createDecipheriv(ALGORITHM, key(secret), iv);
    decipher.setAuthTag(tag);
    decipher.setAAD(Buffer.from(purpose, 'utf8'));
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as unknown;
  } catch {
    // Includes the GCM auth-tag failure, i.e. the tamper case. Deliberately indistinguishable
    // from every other failure to the caller.
    return null;
  }
}

const SESSION_PURPOSE = 'session';
const LOGIN_PURPOSE = 'login';

export const seal = (session: Session, secret: string): string =>
  sealValue(session, secret, SESSION_PURPOSE);

export function unseal(value: string, secret: string): Session | null {
  const parsed = unsealValue(value, secret, SESSION_PURPOSE) as Partial<Session> | null;
  if (parsed === null || typeof parsed !== 'object') return null;

  // Shape check. A cookie we sealed with an older layout must not half-load into a Session whose
  // missing fields would then be read as empty strings — an empty `oid` is not an identity.
  if (
    typeof parsed.accessToken !== 'string' ||
    typeof parsed.refreshToken !== 'string' ||
    typeof parsed.expiresAt !== 'number' ||
    typeof parsed.oid !== 'string' ||
    typeof parsed.csrf !== 'string' ||
    parsed.oid === '' ||
    parsed.csrf === ''
  ) {
    return null;
  }

  return {
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    expiresAt: parsed.expiresAt,
    oid: parsed.oid,
    upn: typeof parsed.upn === 'string' ? parsed.upn : '',
    name: typeof parsed.name === 'string' ? parsed.name : '',
    csrf: parsed.csrf,
  };
}

export const sealLogin = (state: LoginState, secret: string): string =>
  sealValue(state, secret, LOGIN_PURPOSE);

/** Open a sealed login state. Also rejects one whose window has closed. */
export function unsealLogin(value: string, secret: string, now: number): LoginState | null {
  const parsed = unsealValue(value, secret, LOGIN_PURPOSE) as Partial<LoginState> | null;
  if (parsed === null || typeof parsed !== 'object') return null;
  if (
    typeof parsed.verifier !== 'string' ||
    typeof parsed.state !== 'string' ||
    typeof parsed.nonce !== 'string' ||
    typeof parsed.expiresAt !== 'number' ||
    parsed.verifier === '' ||
    parsed.state === ''
  ) {
    return null;
  }
  if (parsed.expiresAt <= now) return null;
  return {
    verifier: parsed.verifier,
    state: parsed.state,
    nonce: parsed.nonce,
    returnTo: typeof parsed.returnTo === 'string' ? parsed.returnTo : '/',
    expiresAt: parsed.expiresAt,
  };
}

/** A CSRF token: random, and compared in constant time. */
export function newCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Compare two CSRF tokens without leaking their contents through timing.
 *
 * `timingSafeEqual` throws on a length mismatch, which is itself a length oracle — so the lengths
 * are compared first and a mismatch returns early. That is not a leak: the token length is fixed
 * and public.
 */
export function csrfMatches(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}
