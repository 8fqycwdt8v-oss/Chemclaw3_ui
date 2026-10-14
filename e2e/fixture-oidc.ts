/**
 * A stand-in OpenID Connect provider, for the BFF's token handler.
 *
 * It speaks the part of the Microsoft identity platform v2.0 the BFF uses: discovery, JWKS, the
 * authorization endpoint (a login page with one button per person, or `?person=` to skip it), the
 * token endpoint for `authorization_code` (PKCE S256 verified) and `refresh_token`, revocation and
 * end-session. Everything is real HTTP on loopback, signed with a real RSA key, so the BFF's
 * validation runs the code it ships.
 *
 * **Faults are knobs, not mocks.** `behaviour` is a plain object a test mutates between steps: an
 * ID token with the wrong nonce, an expired one, a bad signature; a refresh that answers
 * `invalid_grant` or a 500; a slow token endpoint (to make concurrent refreshes overlap); rotating
 * refresh tokens with reuse detection. `calls` counts what arrived, so single-flight is a number.
 *
 * Used two ways: imported by vitest (`startFixtureOidc`), and run as a process for Playwright —
 *
 *   node --experimental-strip-types e2e/fixture-oidc.ts <port> <client-id> <redirect-uri>
 *
 * Parameter properties and enums are avoided: this file runs under Node's type stripping.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { JWK } from 'jose';

export interface Person {
  key: string;
  oid: string;
  name: string;
  upn: string;
  roles: string[];
}

export const ALICE: Person = {
  key: 'alice',
  oid: '00000000-0000-0000-0000-00000000a11c',
  name: 'Alice Chemist',
  upn: 'alice@fixture.test',
  roles: ['chemist', 'reviewer'],
};
export const BOB: Person = {
  key: 'bob',
  oid: '00000000-0000-0000-0000-000000000b0b',
  name: 'Bob Chemist',
  upn: 'bob@fixture.test',
  roles: ['chemist'],
};

export interface FixtureOidcOptions {
  port?: number;
  clientId: string;
  /** `null` is a public client: the token endpoint then refuses a request that sends a secret. */
  clientSecret: string | null;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  /** The `aud` of the access tokens: the API the BFF calls on the person's behalf. */
  audience?: string;
  accessTtlSeconds?: number;
  people?: Person[];
}

/** Everything a test may change while the provider runs. */
export interface Behaviour {
  accessTtlSeconds: number;
  issueRefreshToken: boolean;
  /** Replace the refresh token on every refresh; a reused old one then revokes the family. */
  rotateRefreshTokens: boolean;
  /** Made to the next ID token(s) only while set. */
  idToken: {
    nonce?: string;
    expired?: boolean;
    badSignature?: boolean;
    issuer?: string;
    audience?: string;
    omit?: boolean;
    /**
     * Sign with an algorithm a client must never accept for an ID token: `none` (unsigned) or
     * `HS256` keyed with the client secret, the classic downgrade.
     */
    alg?: 'none' | 'HS256';
  };
  /** Answer refresh requests with this instead of a token set. */
  refreshFails: 'invalid_grant' | 'server_error' | 'unreachable' | null;
  /** Hold every token-endpoint answer this long. */
  tokenDelayMs: number;
  /** Refuse code exchange outright. */
  codeFails: boolean;
}

export interface Calls {
  authorize: number;
  codeExchanges: number;
  refreshes: number;
  revocations: number;
  endSessions: number;
  jwks: number;
  discovery: number;
}

export interface FixtureOidc {
  /** `http://127.0.0.1:<port>/<tenant>` — what the BFF takes as `ENTRA_AUTHORITY`. */
  authority: string;
  origin: string;
  port: number;
  behaviour: Behaviour;
  calls: Calls;
  /** Every access token issued, in order. */
  accessTokens: string[];
  /** The raw form fields of every token request. */
  tokenRequests: Record<string, string>[];
  /** Refresh tokens revoked through `/revoke`. */
  revoked: Set<string>;
  /** Publish a new signing key; the old one stays in the key set. */
  rotateKey: () => Promise<void>;
  /** Forget every code and refresh token (an administrator revoking the user's sessions). */
  revokeAll: () => void;
  close: () => Promise<void>;
}

const TENANT = 'fixture-tenant';

const b64url = (buffer: Buffer): string => buffer.toString('base64url');

interface CodeGrant {
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string;
  person: Person;
  scope: string;
  expiresAt: number;
}

interface RefreshGrant {
  clientId: string;
  person: Person;
  scope: string;
  family: string;
}

export async function startFixtureOidc(options: FixtureOidcOptions): Promise<FixtureOidc> {
  const people = options.people ?? [ALICE, BOB];
  const audience = options.audience ?? 'api://chemclaw';

  const behaviour: Behaviour = {
    accessTtlSeconds: options.accessTtlSeconds ?? 3600,
    issueRefreshToken: true,
    rotateRefreshTokens: false,
    idToken: {},
    refreshFails: null,
    tokenDelayMs: 0,
    codeFails: false,
  };
  const calls: Calls = {
    authorize: 0,
    codeExchanges: 0,
    refreshes: 0,
    revocations: 0,
    endSessions: 0,
    jwks: 0,
    discovery: 0,
  };
  const accessTokens: string[] = [];
  const tokenRequests: Record<string, string>[] = [];
  const revoked = new Set<string>();
  const codes = new Map<string, CodeGrant>();
  const refreshTokens = new Map<string, RefreshGrant>();
  const deadFamilies = new Set<string>();
  const spent = new Set<string>();

  interface SigningKey {
    kid: string;
    privateKey: CryptoKey;
    jwk: JWK;
  }
  const newKey = async (kid: string): Promise<SigningKey> => {
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    return {
      kid,
      privateKey,
      jwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' },
    };
  };
  const publishedKeys: SigningKey[] = [await newKey('key-1')];
  let signing = publishedKeys[0] as SigningKey;
  // A key the provider never publishes, for "signed by somebody else".
  const strangerKey = await newKey('key-1');

  let origin = '';
  const authority = (): string => `${origin}/${TENANT}`;
  const issuer = (): string => `${authority()}/v2.0`;

  const sign = async (
    claims: Record<string, unknown>,
    key: SigningKey,
    expiresInSeconds: number,
  ): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'JWT' })
      .setIssuedAt(now)
      .setNotBefore(now - 5)
      .setExpirationTime(now + expiresInSeconds)
      .sign(key.privateKey);
  };

  const accessTokenFor = async (person: Person, scope: string): Promise<string> => {
    const token = await sign(
      {
        // A unique id, as real providers add: two tokens minted in one second must differ.
        jti: b64url(randomBytes(12)),
        iss: issuer(),
        aud: audience,
        sub: `sub-${person.key}`,
        oid: person.oid,
        preferred_username: person.upn,
        name: person.name,
        roles: person.roles,
        scp:
          scope
            .split(' ')
            .find((s) => s.includes('/'))
            ?.split('/')
            .pop() ?? 'Chat.Access',
      },
      signing,
      behaviour.accessTtlSeconds,
    );
    accessTokens.push(token);
    return token;
  };

  const idTokenFor = async (person: Person, nonce: string): Promise<string> => {
    const over = behaviour.idToken;
    if (over.alg) return downgraded(over.alg, person, nonce);
    return sign(
      {
        iss: over.issuer ?? issuer(),
        aud: over.audience ?? options.clientId,
        sub: `sub-${person.key}`,
        oid: person.oid,
        preferred_username: person.upn,
        name: person.name,
        roles: person.roles,
        nonce: over.nonce ?? nonce,
      },
      over.badSignature ? strangerKey : signing,
      over.expired ? -3600 : 3600,
    );
  };

  /** An ID token under an algorithm the BFF must refuse, whatever else is right about it. */
  const downgraded = async (
    alg: 'none' | 'HS256',
    person: Person,
    nonce: string,
  ): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: issuer(),
      aud: options.clientId,
      sub: `sub-${person.key}`,
      oid: person.oid,
      name: person.name,
      nonce,
      iat: now,
      exp: now + 3600,
    };
    if (alg === 'HS256') {
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .sign(new TextEncoder().encode(options.clientSecret ?? 'public-client'));
    }
    const part = (value: unknown): string => b64url(Buffer.from(JSON.stringify(value)));
    return `${part({ alg: 'none', typ: 'JWT' })}.${part(claims)}.`;
  };

  const readForm = async (req: IncomingMessage): Promise<Record<string, string>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
  };

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const redirect = (res: ServerResponse, location: string): void => {
    res.writeHead(302, { location });
    res.end();
  };

  const loginPage = (res: ServerResponse, query: URLSearchParams): void => {
    const buttons = people
      .map((p) => {
        const next = new URLSearchParams(query);
        next.set('person', p.key);
        return `<p><a data-testid="fixture-login-${p.key}" href="?${next.toString().replace(/&/g, '&amp;')}">Sign in as ${p.name}</a></p>`;
      })
      .join('');
    const deny = new URLSearchParams(query);
    deny.set('person', 'deny');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><title>Fixture identity provider</title><h1>Fixture identity provider</h1>${buttons}` +
        `<p><a data-testid="fixture-login-deny" href="?${deny.toString().replace(/&/g, '&amp;')}">Cancel</a></p>`,
    );
  };

  const authorize = (res: ServerResponse, query: URLSearchParams): void => {
    calls.authorize += 1;
    const redirectUri = query.get('redirect_uri') ?? '';
    // An unknown client or redirect URI is never redirected to: that is the open-redirect hole.
    if (
      query.get('client_id') !== options.clientId ||
      !options.redirectUris.includes(redirectUri)
    ) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('invalid client_id or redirect_uri');
      return;
    }
    const back = new URL(redirectUri);
    const state = query.get('state');
    if (state) back.searchParams.set('state', state);
    if (
      query.get('response_type') !== 'code' ||
      query.get('code_challenge_method') !== 'S256' ||
      !query.get('code_challenge') ||
      !query.get('nonce')
    ) {
      back.searchParams.set('error', 'invalid_request');
      return redirect(res, back.toString());
    }
    const pick = query.get('person');
    if (!pick) return loginPage(res, query);
    const person = people.find((p) => p.key === pick);
    if (!person) {
      back.searchParams.set('error', 'access_denied');
      return redirect(res, back.toString());
    }
    const code = b64url(randomBytes(24));
    codes.set(code, {
      clientId: options.clientId,
      redirectUri,
      challenge: query.get('code_challenge') ?? '',
      nonce: query.get('nonce') ?? '',
      person,
      scope: query.get('scope') ?? '',
      expiresAt: Date.now() + 60_000,
    });
    back.searchParams.set('code', code);
    redirect(res, back.toString());
  };

  /** Whether the request's client credentials are the registered ones. */
  const clientOk = (req: IncomingMessage, form: Record<string, string>): boolean => {
    if (form.client_id !== options.clientId) return false;
    if (options.clientSecret === null) return form.client_secret === undefined;
    return form.client_secret === options.clientSecret;
  };

  const tokenEndpoint = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const form = await readForm(req);
    tokenRequests.push(form);
    if (behaviour.tokenDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, behaviour.tokenDelayMs));
    }
    if (!clientOk(req, form)) return json(res, 401, { error: 'invalid_client' });

    if (form.grant_type === 'authorization_code') {
      calls.codeExchanges += 1;
      if (behaviour.codeFails) return json(res, 400, { error: 'invalid_grant' });
      const grant = codes.get(form.code ?? '');
      codes.delete(form.code ?? '');
      if (!grant || grant.expiresAt < Date.now()) return json(res, 400, { error: 'invalid_grant' });
      if (grant.redirectUri !== form.redirect_uri)
        return json(res, 400, { error: 'invalid_grant' });
      const challenge = createHash('sha256')
        .update(form.code_verifier ?? '')
        .digest('base64url');
      if (challenge !== grant.challenge) return json(res, 400, { error: 'invalid_grant' });

      const body: Record<string, unknown> = {
        token_type: 'Bearer',
        scope: grant.scope,
        expires_in: behaviour.accessTtlSeconds,
        access_token: await accessTokenFor(grant.person, grant.scope),
      };
      if (!behaviour.idToken.omit) body.id_token = await idTokenFor(grant.person, grant.nonce);
      if (behaviour.issueRefreshToken) {
        const refresh = `rt-${b64url(randomBytes(24))}`;
        refreshTokens.set(refresh, {
          clientId: grant.clientId,
          person: grant.person,
          scope: grant.scope,
          family: refresh,
        });
        body.refresh_token = refresh;
      }
      return json(res, 200, body);
    }

    if (form.grant_type === 'refresh_token') {
      calls.refreshes += 1;
      if (behaviour.refreshFails === 'invalid_grant')
        return json(res, 400, { error: 'invalid_grant' });
      if (behaviour.refreshFails === 'server_error')
        return json(res, 500, { error: 'server_error' });
      if (behaviour.refreshFails === 'unreachable') return void req.socket.destroy();
      const presented = form.refresh_token ?? '';
      const grant = refreshTokens.get(presented);
      if (!grant || revoked.has(presented) || deadFamilies.has(grant.family)) {
        return json(res, 400, { error: 'invalid_grant' });
      }
      if (spent.has(presented)) {
        // A rotated-away token coming back means two holders: kill the family, as providers do.
        deadFamilies.add(grant.family);
        return json(res, 400, { error: 'invalid_grant' });
      }
      const body: Record<string, unknown> = {
        token_type: 'Bearer',
        scope: grant.scope,
        expires_in: behaviour.accessTtlSeconds,
        access_token: await accessTokenFor(grant.person, grant.scope),
      };
      if (behaviour.rotateRefreshTokens) {
        // The old one is spent, so presenting it again is reuse.
        spent.add(presented);
        const next = `rt-${b64url(randomBytes(24))}`;
        refreshTokens.set(next, { ...grant });
        body.refresh_token = next;
      }
      return json(res, 200, body);
    }
    return json(res, 400, { error: 'unsupported_grant_type' });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', origin);
    const path = url.pathname;
    const base = `/${TENANT}`;

    if (path === '/healthz') return json(res, 200, { ok: true });
    // For a browser test to read what the provider saw, from outside the process.
    if (path === '/__fixture/state') {
      return json(res, 200, { calls, tokenRequests: tokenRequests.length, revoked: revoked.size });
    }

    if (path === `${base}/v2.0/.well-known/openid-configuration`) {
      calls.discovery += 1;
      return json(res, 200, {
        issuer: issuer(),
        authorization_endpoint: `${authority()}/oauth2/v2.0/authorize`,
        token_endpoint: `${authority()}/oauth2/v2.0/token`,
        jwks_uri: `${authority()}/discovery/v2.0/keys`,
        end_session_endpoint: `${authority()}/oauth2/v2.0/logout`,
        revocation_endpoint: `${authority()}/oauth2/v2.0/revoke`,
        response_types_supported: ['code'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (path === `${base}/discovery/v2.0/keys`) {
      calls.jwks += 1;
      return json(res, 200, { keys: publishedKeys.map((k) => k.jwk) });
    }
    if (path === `${base}/oauth2/v2.0/authorize`) return authorize(res, url.searchParams);
    if (path === `${base}/oauth2/v2.0/token` && req.method === 'POST') {
      return tokenEndpoint(req, res);
    }
    if (path === `${base}/oauth2/v2.0/revoke` && req.method === 'POST') {
      calls.revocations += 1;
      const form = await readForm(req);
      if (form.token) revoked.add(form.token);
      return json(res, 200, {});
    }
    if (path === `${base}/oauth2/v2.0/logout`) {
      calls.endSessions += 1;
      const back = url.searchParams.get('post_logout_redirect_uri') ?? '';
      if (
        url.searchParams.get('client_id') === options.clientId &&
        options.postLogoutRedirectUris.includes(back)
      ) {
        return redirect(res, back);
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('signed out');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  origin = `http://127.0.0.1:${port}`;

  return {
    authority: authority(),
    origin,
    port,
    behaviour,
    calls,
    accessTokens,
    tokenRequests,
    revoked,
    async rotateKey() {
      const key = await newKey(`key-${publishedKeys.length + 1}`);
      publishedKeys.push(key);
      signing = key;
    },
    revokeAll() {
      codes.clear();
      refreshTokens.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** As a process, for Playwright: `<port> <client-id> <redirect-uri> [post-logout-uri]`. */
const entry = process.argv[1] ?? '';
if (entry.endsWith('fixture-oidc.ts')) {
  const [port, clientId, redirectUri, postLogout] = process.argv.slice(2);
  const idp = await startFixtureOidc({
    port: Number(port ?? 4350),
    clientId: clientId ?? 'chemclaw-bff-e2e',
    clientSecret: process.env.FIXTURE_CLIENT_SECRET ?? 'fixture-secret',
    redirectUris: [redirectUri ?? 'http://127.0.0.1:4341/auth/callback'],
    postLogoutRedirectUris: [postLogout ?? 'http://127.0.0.1:4341/'],
    accessTtlSeconds: Number(process.env.FIXTURE_ACCESS_TTL_SECONDS ?? 3600),
  });
  console.log(`fixture oidc on ${idp.origin}`);
}
