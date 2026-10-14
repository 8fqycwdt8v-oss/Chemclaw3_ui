/**
 * The OpenID Connect client: discovery, the authorization-code exchange with PKCE, refresh,
 * revocation, and validation of the ID token.
 *
 * Everything the identity provider says is checked here before the rest of the BFF sees it. The ID
 * token is verified with `jose` against the provider's published keys (cached, re-read when a `kid`
 * is unknown, so rotation needs no restart): signature with an asymmetric algorithm only, `iss`
 * equal to the issuer discovery reports (and to `ENTRA_ISSUER` when pinned), `aud` equal to this
 * client, `exp` present and in the future, and the `nonce` this sign-in minted. Network failure
 * and a provider that answers "no" are different errors, because one ends a session and the other
 * must not.
 */

import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import type { AccountView } from '../../shared/auth.ts';
import { log } from '../log.ts';
import { sameSecret } from './sessions.ts';

/** The provider answered, and the answer was no (a bad code, a revoked or expired refresh token). */
export class IdpRejected extends Error {
  readonly oauthError: string;

  constructor(oauthError: string, message: string) {
    super(message);
    this.name = 'IdpRejected';
    this.oauthError = oauthError;
  }
}

/** The provider could not be asked, or failed to answer: try again later; nothing was decided. */
export class IdpUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdpUnavailable';
  }
}

export interface OidcOptions {
  /** `https://login.microsoftonline.com/<tenant>`, or a test authority. No trailing slash. */
  authority: string;
  clientId: string;
  /** `null` is a public client: PKCE alone. */
  clientSecret: string | null;
  /** Space-separated; includes `openid` and `offline_access`. */
  scope: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  /** When set, discovery's issuer must equal it. */
  issuer?: string;
  endSession: boolean;
  timeoutMs: number;
  /** After a key id is not found, how long before the key set is fetched again. */
  jwksCooldownMs?: number;
  fetchImpl?: typeof fetch;
}

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  revocation_endpoint?: string;
}

export interface TokenSet {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
  refreshToken: string | null;
  idToken: string | null;
}

/** How long a discovery document is trusted before it is read again. */
const DISCOVERY_TTL_MS = 3_600_000;

/** A discovery document that could not be refreshed is asked for again after this. */
const RETRY_STALE_DISCOVERY_MS = 60_000;

/** After a key is not found, how long before the key set is fetched again (a flood bound). */
const JWKS_COOLDOWN_MS = 30_000;
const JWKS_CACHE_MS = 600_000;

/** Algorithms an ID token may be signed with. Never a shared-secret one. */
const ID_TOKEN_ALGORITHMS = ['RS256', 'PS256', 'ES256'];

/** Seconds of clock difference tolerated between this process and the provider. */
const CLOCK_TOLERANCE_S = 60;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

export class OidcClient {
  private discovered: { at: number; doc: Discovery } | null = null;
  private discovering: Promise<Discovery> | null = null;
  private jwks: { uri: string; keys: ReturnType<typeof createRemoteJWKSet> } | null = null;
  private readonly http: typeof fetch;
  private readonly options: OidcOptions;
  private readonly now: () => number;

  constructor(options: OidcOptions, now: () => number = Date.now) {
    this.options = options;
    this.now = now;
    this.http = options.fetchImpl ?? fetch;
  }

  /** A JSON GET/POST to the provider, with the whole call bounded by `timeoutMs`. */
  private async call(url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await this.http(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw new IdpUnavailable(
        `identity provider unreachable (${error instanceof Error ? error.name : 'error'})`,
      );
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // A non-JSON body is judged by its status alone.
    }
    return { status: res.status, body };
  }

  /** The provider's discovery document, cached and read once at a time. */
  async discovery(): Promise<Discovery> {
    const at = this.now();
    if (this.discovered && at - this.discovered.at < DISCOVERY_TTL_MS) return this.discovered.doc;
    this.discovering ??= this.fetchDiscovery()
      .catch((error: unknown) => {
        // A document that was good a moment ago outlives a provider that has a bad minute: keep
        // using it, and ask again in a minute rather than on every request.
        if (!this.discovered) throw error;
        log.warn('discovery refresh failed; using the last document', {
          reason: error instanceof Error ? error.message : 'error',
        });
        this.discovered = {
          at: this.now() - DISCOVERY_TTL_MS + RETRY_STALE_DISCOVERY_MS,
          doc: this.discovered.doc,
        };
        return this.discovered.doc;
      })
      .finally(() => {
        this.discovering = null;
      });
    return this.discovering;
  }

  private async fetchDiscovery(): Promise<Discovery> {
    const url = `${this.options.authority}/v2.0/.well-known/openid-configuration`;
    const { status, body } = await this.call(url, { headers: { accept: 'application/json' } });
    if (status !== 200 || !isRecord(body)) {
      throw new IdpUnavailable(`discovery at ${url} answered ${status}`);
    }
    const issuer = str(body.issuer);
    const authorize = str(body.authorization_endpoint);
    const token = str(body.token_endpoint);
    const jwks = str(body.jwks_uri);
    if (!issuer || !authorize || !token || !jwks) {
      throw new IdpUnavailable('discovery document lacks issuer, endpoints or jwks_uri');
    }
    if (this.options.issuer && issuer !== this.options.issuer) {
      throw new IdpUnavailable(
        `discovery reports issuer ${issuer}, not the pinned ${this.options.issuer}`,
      );
    }
    const doc: Discovery = {
      issuer,
      authorization_endpoint: authorize,
      token_endpoint: token,
      jwks_uri: jwks,
      ...(str(body.end_session_endpoint)
        ? { end_session_endpoint: str(body.end_session_endpoint)! }
        : {}),
      ...(str(body.revocation_endpoint)
        ? { revocation_endpoint: str(body.revocation_endpoint)! }
        : {}),
    };
    this.discovered = { at: this.now(), doc };
    return doc;
  }

  /** The URL to send the browser to, for one sign-in. */
  async authorizeUrl(params: { state: string; nonce: string; challenge: string }): Promise<string> {
    const doc = await this.discovery();
    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', this.options.redirectUri);
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('scope', this.options.scope);
    url.searchParams.set('state', params.state);
    url.searchParams.set('nonce', params.nonce);
    url.searchParams.set('code_challenge', params.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  /** The token endpoint, with this client's credentials on the form. */
  private async tokenRequest(form: Record<string, string>): Promise<TokenSet> {
    const doc = await this.discovery();
    const body = new URLSearchParams({ client_id: this.options.clientId, ...form });
    if (this.options.clientSecret) body.set('client_secret', this.options.clientSecret);
    const { status, body: json } = await this.call(doc.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
    if (status >= 500 || status === 429 || status === 0) {
      throw new IdpUnavailable(`token endpoint answered ${status}`);
    }
    if (status !== 200 || !isRecord(json)) {
      const code = isRecord(json) ? (str(json.error) ?? 'invalid_response') : 'invalid_response';
      // The provider's own words describe the user's account; the code is enough to act on.
      if (code === 'temporarily_unavailable' || code === 'server_error') {
        throw new IdpUnavailable(`token endpoint: ${code}`);
      }
      throw new IdpRejected(code, `token endpoint refused: ${code}`);
    }
    const accessToken = str(json.access_token);
    if (!accessToken)
      throw new IdpRejected('invalid_response', 'token response has no access_token');
    const lifetime = Number(json.expires_in);
    return {
      accessToken,
      expiresAt: this.now() + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 300) * 1000,
      refreshToken: str(json.refresh_token) ?? null,
      idToken: str(json.id_token) ?? null,
    };
  }

  exchangeCode(code: string, verifier: string): Promise<TokenSet> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.options.redirectUri,
      code_verifier: verifier,
      scope: this.options.scope,
    });
  }

  refresh(refreshToken: string): Promise<TokenSet> {
    return this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: this.options.scope,
    });
  }

  /**
   * Validate an ID token and read the person out of it. Throws `IdpRejected('invalid_id_token')`
   * for anything wrong with the token itself, `IdpUnavailable` when the keys cannot be fetched.
   */
  async verifyIdToken(idToken: string, nonce: string): Promise<AccountView> {
    const doc = await this.discovery();
    if (this.jwks?.uri !== doc.jwks_uri) {
      this.jwks = {
        uri: doc.jwks_uri,
        keys: createRemoteJWKSet(new URL(doc.jwks_uri), {
          timeoutDuration: this.options.timeoutMs,
          cooldownDuration: this.options.jwksCooldownMs ?? JWKS_COOLDOWN_MS,
          cacheMaxAge: JWKS_CACHE_MS,
        }),
      };
    }
    let claims: JWTPayload;
    try {
      ({ payload: claims } = await jwtVerify(idToken, this.jwks.keys, {
        issuer: doc.issuer,
        audience: this.options.clientId,
        algorithms: ID_TOKEN_ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE_S,
        // `exp` bounds the token's life and `nonce` (below) binds it to this sign-in; `iat` adds
        // nothing either guards against, so a provider that omits it is not refused for it.
        requiredClaims: ['exp', 'sub'],
      }));
    } catch (error) {
      // The key set not arriving (timeout, a non-200, a dropped connection) is the provider's
      // absence; every other `jose` error is a verdict on the token.
      const verdict =
        error instanceof errors.JOSEError &&
        !(error instanceof errors.JWKSTimeout) &&
        error.code !== 'ERR_JOSE_GENERIC';
      if (!verdict) throw new IdpUnavailable('signing keys could not be fetched');
      throw new IdpRejected('invalid_id_token', `ID token refused (${error.code})`);
    }
    if (typeof claims.nonce !== 'string' || !sameSecret(claims.nonce, nonce)) {
      throw new IdpRejected('invalid_id_token', 'ID token nonce does not match this sign-in');
    }
    const id = str(claims.oid) ?? str(claims.sub) ?? '';
    const username = str(claims.preferred_username) ?? str(claims.email) ?? str(claims.upn) ?? id;
    return {
      id,
      username,
      name: str(claims.name) ?? username,
      roles: Array.isArray(claims.roles) ? claims.roles.map(String) : [],
    };
  }

  /** Revoke a refresh token where the provider offers it. Best effort: sign-out must not fail on it. */
  async revoke(refreshToken: string): Promise<boolean> {
    const doc = await this.discovery().catch(() => null);
    if (!doc?.revocation_endpoint) return false;
    const body = new URLSearchParams({
      client_id: this.options.clientId,
      token: refreshToken,
      token_type_hint: 'refresh_token',
    });
    if (this.options.clientSecret) body.set('client_secret', this.options.clientSecret);
    try {
      const { status } = await this.call(doc.revocation_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      return status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Where to send the browser to end the provider's own session, or `null`. Carries no token: the
   * provider is told which client and where to come back to, nothing more.
   */
  async endSessionUrl(): Promise<string | null> {
    if (!this.options.endSession) return null;
    const doc = await this.discovery().catch(() => null);
    if (!doc?.end_session_endpoint) return null;
    const url = new URL(doc.end_session_endpoint);
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('post_logout_redirect_uri', this.options.postLogoutRedirectUri);
    return url.toString();
  }
}
