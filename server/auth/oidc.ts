/**
 * The OpenID Connect authorization-code exchange, spoken directly to Entra.
 *
 * Hand-rolled rather than delegated to `openid-client` or `@azure/msal-node`. Both are large, both
 * carry their own crypto and metadata-caching machinery, and what is actually needed here is four
 * URLs and two `fetch` calls with a fixed set of parameters. The saving is not the bytes — it is
 * that everything this process does with a token is visible in one readable file.
 *
 * This is a **confidential** client: `ENTRA_CLIENT_SECRET` is required, which is a new
 * app-registration requirement compared with the SPA flow. The registration needs a *Web* platform
 * with `<origin>/auth/callback` as a redirect URI, not the SPA platform the browser-MSAL mode uses.
 * A SPA-platform registration will be refused by Entra with AADSTS9002326 the moment a secret is
 * presented, which is a confusing error to meet for the first time in production.
 */

import { createHash, randomBytes } from 'node:crypto';

/** How long a token request may take before it is abandoned. Entra is normally well under a second. */
const TOKEN_TIMEOUT_MS = 10_000;

export interface OidcSettings {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** The API scope, e.g. `api://<api-client-id>/Chat.Access`. */
  apiScope: string;
  /**
   * The identity provider's origin. Defaults to the commercial cloud.
   *
   * Overridable because Entra is not one host: sovereign deployments live at
   * `login.microsoftonline.us` and `login.partner.microsoftonline.cn`, and a tenant in one of those
   * cannot be reached at the commercial endpoint at all. It is also what lets the auth flow be
   * tested end to end against a mock provider, which is otherwise untestable without a real tenant.
   *
   * `validateConfig` requires it to be HTTPS unless it is loopback, so this cannot quietly become a
   * way to send tokens somewhere in the clear.
   */
  authorityHost?: string;
}

const DEFAULT_AUTHORITY_HOST = 'https://login.microsoftonline.com';

/** What a successful `/token` call yields, after the fields this app does not use are dropped. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms, computed from `expires_in` at the moment of the response. */
  expiresAt: number;
  /** Present on the initial exchange, absent on a refresh that did not re-issue one. */
  idToken: string | null;
}

/** The identity claims the BFF keeps. Deliberately not the whole token. */
export interface IdentityClaims {
  oid: string;
  upn: string;
  name: string;
  roles: string[];
  nonce: string | null;
}

export class OidcError extends Error {
  /**
   * Entra's own error code (`invalid_grant`, `interaction_required`, …) when it gave one.
   *
   * Declared and assigned rather than written as a TypeScript parameter property: the server runs
   * under `node --experimental-strip-types`, which erases annotations without transforming
   * anything, and a parameter property is a transform. It fails at load with
   * ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX — i.e. the process does not start.
   */
  readonly code: string | null;

  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = 'OidcError';
    this.code = code;
  }
}

const authority = (s: OidcSettings): string =>
  `${s.authorityHost ?? DEFAULT_AUTHORITY_HOST}/${encodeURIComponent(s.tenantId)}/oauth2/v2.0`;

/**
 * The scopes requested.
 *
 * `offline_access` is what makes a refresh token appear at all — without it the session dies with
 * the first access token and the user is bounced to Entra roughly every hour. `openid` and
 * `profile` are what make an id_token appear, which is where the identity claims come from.
 *
 * The API scope must be a real scope (`api://<id>/<name>`), not a bare App ID URI: the latter
 * yields a token whose `aud` is this client, which the backend's audience check rejects. `env.ts`
 * makes the same point on the browser side and refuses to boot on it.
 */
const scopes = (apiScope: string): string => `openid profile offline_access ${apiScope}`;

/** A PKCE verifier and its S256 challenge. */
export interface Pkce {
  verifier: string;
  challenge: string;
}

export function createPkce(): Pkce {
  // 32 bytes base64url is 43 characters, the shortest length RFC 7636 permits.
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export const randomToken = (): string => randomBytes(32).toString('base64url');

/**
 * Where to send the browser to sign in.
 *
 * `response_mode=query`, not `form_post`, and the reason is the session cookie. `form_post` returns
 * the code as a cross-site POST, and a `SameSite=Lax` cookie is withheld on those — so the login
 * state this callback must read would simply not be there. Lax *is* sent on a top-level cross-site
 * GET navigation, which is what a query-mode redirect is. The code sits in a URL for one request
 * either way; it is single-use, PKCE-bound, and the callback exchanges and discards it immediately.
 */
export function authorizeUrl(
  settings: OidcSettings,
  params: { redirectUri: string; state: string; nonce: string; challenge: string },
): string {
  const url = new URL(`${authority(settings)}/authorize`);
  url.searchParams.set('client_id', settings.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', scopes(settings.apiScope));
  url.searchParams.set('state', params.state);
  url.searchParams.set('nonce', params.nonce);
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** Where to send the browser to sign out of the tenant, not just out of this app. */
export function logoutUrl(settings: OidcSettings, postLogoutRedirect: string): string {
  const url = new URL(`${authority(settings)}/logout`);
  url.searchParams.set('post_logout_redirect_uri', postLogoutRedirect);
  return url.toString();
}

async function tokenRequest(
  settings: OidcSettings,
  body: Record<string, string>,
): Promise<TokenSet> {
  let res: Response;
  try {
    res = await fetch(`${authority(settings)}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        scope: scopes(settings.apiScope),
        ...body,
      }).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    throw new OidcError(
      `could not reach the identity provider: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new OidcError(`identity provider returned non-JSON (HTTP ${res.status})`);
  }

  if (!res.ok) {
    // `error_description` carries the AADSTS code, which is the only thing that makes an Entra
    // failure diagnosable. It is logged, never returned to the browser: it names tenant internals.
    const code = typeof parsed.error === 'string' ? parsed.error : null;
    const detail =
      typeof parsed.error_description === 'string'
        ? parsed.error_description
        : `HTTP ${res.status}`;
    throw new OidcError(detail, code);
  }

  const accessToken = parsed.access_token;
  const refreshToken = parsed.refresh_token;
  const expiresIn = parsed.expires_in;
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new OidcError('identity provider returned no access token');
  }
  // A missing refresh token is not fatal here — it means `offline_access` was not consented — but
  // it does mean the session cannot outlive this access token, so it is worth being explicit.
  return {
    accessToken,
    refreshToken: typeof refreshToken === 'string' ? refreshToken : '',
    expiresAt: Date.now() + (typeof expiresIn === 'number' ? expiresIn : 3600) * 1000,
    idToken: typeof parsed.id_token === 'string' ? parsed.id_token : null,
  };
}

export const exchangeCode = (
  settings: OidcSettings,
  params: { code: string; verifier: string; redirectUri: string },
): Promise<TokenSet> =>
  tokenRequest(settings, {
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.verifier,
  });

export const refreshTokens = (settings: OidcSettings, refreshToken: string): Promise<TokenSet> =>
  tokenRequest(settings, { grant_type: 'refresh_token', refresh_token: refreshToken });

/**
 * Read the claims out of an id_token **without verifying its signature**.
 *
 * That is deliberate and it is what OIDC Core §3.1.3.7 permits: this token did not arrive through
 * the browser, it came back on a TLS connection this process opened directly to Entra's token
 * endpoint, authenticated with the client secret. There is no untrusted party in between to have
 * substituted it. Verifying would mean fetching and caching the tenant's JWKS and implementing
 * RS256 validation here — a second, weaker copy of what the backend already does on every request
 * with the *access* token, which is the token that actually authorizes anything.
 *
 * What is still checked is `nonce`, below, because that defends against a different thing: a token
 * legitimately issued by Entra for a *different* login being injected into this one.
 */
export function readIdToken(idToken: string): IdentityClaims | null {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const oid = typeof payload.oid === 'string' ? payload.oid : '';
    if (oid === '') return null;
    const upn =
      typeof payload.preferred_username === 'string'
        ? payload.preferred_username
        : typeof payload.upn === 'string'
          ? payload.upn
          : '';
    return {
      oid,
      upn,
      name: typeof payload.name === 'string' ? payload.name : upn,
      roles: Array.isArray(payload.roles)
        ? payload.roles.filter((r): r is string => typeof r === 'string')
        : [],
      nonce: typeof payload.nonce === 'string' ? payload.nonce : null,
    };
  } catch {
    return null;
  }
}
