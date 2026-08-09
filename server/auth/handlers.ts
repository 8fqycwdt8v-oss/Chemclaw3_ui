/**
 * The four `/auth/*` routes, and the session refresh the proxy leans on.
 *
 * Only mounted in `bff` mode. In `msal-spa` and `dev` these paths fall through to the SPA's static
 * fallback exactly as they did before, so `/auth/callback` still resolves to `index.html` for
 * browser-MSAL's redirect handling.
 *
 * A word on what is *not* here: there is no server-side session store, by design. The tokens live
 * sealed in the cookie, so this process holds no per-user state, survives its own restart, and
 * scales across replicas with nothing new to run. The cost is revocation — a sealed cookie stays
 * valid until it expires, so `/auth/logout` clears the browser's copy rather than invalidating a
 * record, and a stolen cookie remains usable for the life of the access token inside it. That is
 * the accepted trade of a stateless design and it should be visible here rather than discovered.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { cfg } from '../config.ts';
import { cookieSecure, selfOrigin } from '../httpUtil.ts';
import { log } from '../log.ts';
import {
  clearAuthCookies,
  clearLoginCookie,
  readLoginCookie,
  readSessionCookie,
  writeCsrfCookie,
  writeLoginCookie,
  writeSessionCookie,
  type CookieOptions,
} from './cookies.ts';
import { checkCsrf } from './csrf.ts';
import {
  authorizeUrl,
  createPkce,
  exchangeCode,
  logoutUrl,
  OidcError,
  randomToken,
  readIdToken,
  refreshTokens,
  type OidcSettings,
  type TokenSet,
} from './oidc.ts';
import { newCsrfToken, seal, sealLogin, unseal, unsealLogin, type Session } from './session.ts';

/** How long a started-but-unfinished sign-in stays answerable. Entra's own code lifetime is 10 min. */
const LOGIN_WINDOW_MS = 10 * 60_000;

/**
 * Refresh this far before the access token actually expires.
 *
 * Long enough to cover a slow turn: the token is checked once when the request is proxied, and a
 * streaming turn can run for the backend's full 600s wall clock afterwards. A token that was valid
 * at the first byte and expires mid-stream is not something the proxy can fix, so the window is
 * wide enough that it does not arise for any normal turn.
 */
const REFRESH_SKEW_MS = 11 * 60_000;

const settings = (): OidcSettings => ({
  tenantId: cfg.entraTenantId,
  clientId: cfg.entraClientId,
  clientSecret: cfg.entraClientSecret,
  apiScope: cfg.apiScope,
  authorityHost: cfg.entraAuthorityHost,
});

const cookieOptions = (req: IncomingMessage): CookieOptions => ({ secure: cookieSecure(req) });

const redirectUri = (req: IncomingMessage): string => `${selfOrigin(req)}/auth/callback`;

/**
 * Where the browser may be sent after sign-in or sign-out.
 *
 * Only a same-origin *path*. Anything else — an absolute URL, a protocol-relative `//evil.test`, a
 * backslash form some browsers normalise to one — collapses to `/`. A `returnTo` that survived into
 * a `Location` header unchecked is a textbook open redirect, and one attached to a login flow is
 * the useful kind: the victim really did just authenticate, so the page they land on is trusted.
 */
export function safeReturnTo(raw: string | null): string {
  if (!raw) return '/';
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * An error the user can act on, without saying anything they should not see.
 *
 * Entra's `error_description` carries AADSTS codes naming tenant configuration; it goes to the log,
 * where an operator can find it, and never into the response.
 */
function authFailure(res: ServerResponse, req: IncomingMessage, detail: string): void {
  clearLoginCookie(res, cookieOptions(req));
  json(res, 400, {
    detail,
    // A dead end otherwise: the SPA's sign-in button is behind the very session this failed to
    // create, so the response has to carry the way to try again.
    retry: '/auth/login',
  });
}

/** Read and open the session cookie, or `null` if there is not a valid one. */
export function loadSession(req: IncomingMessage): Session | null {
  if (cfg.authMode !== 'bff') return null;
  const sealed = readSessionCookie(req, cookieSecure(req));
  if (sealed === null) return null;
  return unseal(sealed, cfg.sessionSecret);
}

/**
 * In-flight refreshes, keyed by the session they belong to.
 *
 * Entra rotates refresh tokens: using one invalidates it and returns a replacement. Two concurrent
 * requests on the same session would otherwise both refresh, the second presenting a token the
 * first had already spent — Entra answers `invalid_grant`, and the user is signed out in the middle
 * of working. Collapsing them onto one promise is what stops that.
 *
 * Per-process, which is enough: a session's requests come from one browser over keep-alive
 * connections that land on one replica for the duration of a page. Across replicas the race is
 * possible and the outcome is one extra sign-in, not corruption.
 */
const inFlightRefresh = new Map<string, Promise<TokenSet | null>>();

async function refreshOnce(session: Session): Promise<TokenSet | null> {
  const existing = inFlightRefresh.get(session.oid);
  if (existing) return existing;

  const attempt = refreshTokens(settings(), session.refreshToken)
    .catch((err: unknown) => {
      const code = err instanceof OidcError ? err.code : null;
      log.warn(
        `token refresh failed for ${session.oid}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // `invalid_grant` means the refresh token is spent or revoked, which is a real sign-out and
      // not a transient failure. Everything else may be worth another try on the next request, so
      // neither case is distinguished here — both yield `null` and the caller keeps the session it
      // has until the access token itself stops working.
      if (code !== null) log.debug(`refresh error code: ${code}`);
      return null;
    })
    .finally(() => {
      inFlightRefresh.delete(session.oid);
    });

  inFlightRefresh.set(session.oid, attempt);
  return attempt;
}

/**
 * The session to use for this request, refreshed and re-sealed if it was about to expire.
 *
 * Refresh is **proactive only**. The plan also called for a retry after an upstream 401, and that
 * is deliberately not here: replaying a request means re-sending its body, and the body of the one
 * request that matters — `POST /sessions/{id}/messages` — has already been streamed to the upstream
 * by the time a status code exists. Replaying it would either double-spend the turn budget or
 * collide with the backend's per-session turn lock, which is the same reason `REPLAYABLE_METHODS`
 * in the proxy excludes POST and `streamTurn` refuses to auto-retry. So a 401 reaches the browser,
 * where `handleUnauthorized` re-checks `/auth/me` and starts a fresh sign-in if the session is
 * genuinely gone. The skew above is what keeps that path rare.
 */
export async function currentSession(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Session | null> {
  const session = loadSession(req);
  if (session === null) return null;
  if (session.expiresAt - Date.now() > REFRESH_SKEW_MS) return session;
  if (!session.refreshToken) return session;

  const tokens = await refreshOnce(session);
  if (tokens === null) return session;

  const refreshed: Session = {
    ...session,
    accessToken: tokens.accessToken,
    // Entra normally returns a new refresh token; keep the old one if it did not, rather than
    // writing an empty string and losing the ability to refresh again.
    refreshToken: tokens.refreshToken || session.refreshToken,
    expiresAt: tokens.expiresAt,
  };
  writeSessionCookie(res, seal(refreshed, cfg.sessionSecret), cookieOptions(req));
  return refreshed;
}

async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const pkce = createPkce();
  const state = randomToken();
  const nonce = randomToken();
  const returnTo = safeReturnTo(query.get('returnTo'));

  writeLoginCookie(
    res,
    sealLogin(
      { verifier: pkce.verifier, state, nonce, returnTo, expiresAt: Date.now() + LOGIN_WINDOW_MS },
      cfg.sessionSecret,
    ),
    { ...cookieOptions(req), maxAge: Math.floor(LOGIN_WINDOW_MS / 1000) },
  );

  redirect(
    res,
    authorizeUrl(settings(), {
      redirectUri: redirectUri(req),
      state,
      nonce,
      challenge: pkce.challenge,
    }),
  );
  return Promise.resolve();
}

async function handleCallback(
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  // Entra reports a refused or cancelled sign-in here rather than at /token.
  const providerError = query.get('error');
  if (providerError) {
    log.warn(
      `sign-in refused by the identity provider: ${query.get('error_description') ?? providerError}`,
    );
    authFailure(res, req, 'Sign-in was not completed.');
    return;
  }

  const sealedLogin = readLoginCookie(req, cookieSecure(req));
  if (sealedLogin === null) {
    // Overwhelmingly a stale tab or a bookmarked callback, not an attack — but the two are
    // indistinguishable from here, so the message covers both without accusing anyone.
    authFailure(res, req, 'This sign-in link has expired. Start again.');
    return;
  }
  const login = unsealLogin(sealedLogin, cfg.sessionSecret, Date.now());
  if (login === null) {
    authFailure(res, req, 'This sign-in link has expired. Start again.');
    return;
  }

  // The state check. `login.state` came out of a cookie we sealed; `query.state` came back through
  // the browser. An attacker who could start their own login and get the victim to complete it
  // would be logging the victim into the attacker's account, which is the login-CSRF this prevents.
  const returnedState = query.get('state') ?? '';
  if (returnedState !== login.state) {
    log.warn('sign-in state mismatch — refusing the callback');
    authFailure(res, req, 'Sign-in could not be verified. Start again.');
    return;
  }

  const code = query.get('code');
  if (!code) {
    authFailure(res, req, 'Sign-in returned no authorization code.');
    return;
  }

  let tokens: TokenSet;
  try {
    tokens = await exchangeCode(settings(), {
      code,
      verifier: login.verifier,
      redirectUri: redirectUri(req),
    });
  } catch (err) {
    log.error(`code exchange failed: ${err instanceof Error ? err.message : String(err)}`);
    authFailure(res, req, 'Could not complete sign-in with the identity provider.');
    return;
  }

  const claims = tokens.idToken === null ? null : readIdToken(tokens.idToken);
  if (claims === null) {
    log.error('no usable id_token in the code exchange response');
    authFailure(res, req, 'Sign-in did not return an identity.');
    return;
  }
  // The nonce binds this id_token to *this* login. Skipping it would let a token Entra legitimately
  // issued for a different authorization request be injected into this session.
  if (claims.nonce !== login.nonce) {
    log.warn('id_token nonce mismatch — refusing the callback');
    authFailure(res, req, 'Sign-in could not be verified. Start again.');
    return;
  }
  if (!tokens.refreshToken) {
    // Not fatal, but the session now cannot outlive its access token, so say so once rather than
    // letting it present as "everyone is signed out roughly every hour".
    log.warn(
      'the identity provider returned no refresh token — check that offline_access is consented, ' +
        'or sessions will end when the access token expires',
    );
  }

  const csrf = newCsrfToken();
  const session: Session = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    oid: claims.oid,
    upn: claims.upn,
    name: claims.name,
    csrf,
  };

  const options = cookieOptions(req);
  try {
    writeSessionCookie(res, seal(session, cfg.sessionSecret), options);
  } catch (err) {
    // The chunk ceiling. Loud by design — see the `cookies.ts` docstring — and this is where it
    // surfaces, rather than as a session that silently fails to stick.
    log.error(err instanceof Error ? err.message : String(err));
    authFailure(res, req, 'The sign-in response was too large to store. Contact an administrator.');
    return;
  }
  writeCsrfCookie(res, csrf, options);
  clearLoginCookie(res, options);
  log.info(`signed in ${claims.upn || claims.oid}`);
  redirect(res, login.returnTo);
}

/**
 * Sign out. A POST, and CSRF-checked like any other state change.
 *
 * Answers with the tenant logout URL rather than redirecting to it, because this is called from
 * `fetch`: a 302 there is followed transparently and cross-origin, so the browser would never
 * navigate and the Entra session would survive. The SPA navigates to what comes back.
 */
function handleLogout(req: IncomingMessage, res: ServerResponse, session: Session | null): void {
  const verdict = checkCsrf(req, session);
  if (!verdict.ok) {
    log.warn(`refused logout: ${verdict.reason}`);
    json(res, 403, { detail: 'This request could not be verified.' });
    return;
  }
  clearAuthCookies(res, cookieOptions(req));
  if (session !== null) log.info(`signed out ${session.upn || session.oid}`);
  json(res, 200, { signOutUrl: logoutUrl(settings(), `${selfOrigin(req)}/`) });
}

/** Who the caller is. Never the token — that is the entire point of this mode. */
function handleMe(res: ServerResponse, session: Session | null): void {
  if (session === null) {
    json(res, 200, { authenticated: false });
    return;
  }
  json(res, 200, {
    authenticated: true,
    id: session.oid,
    username: session.upn,
    name: session.name,
    // Roles are not carried in the session: they belong to the access token, the backend enforces
    // on them, and a copy here would be a second source of truth that can only ever be staler.
    // The SPA uses roles to grey out affordances; an empty list greys out nothing, which is the
    // right failure direction for something that is not enforcement.
    roles: [],
  });
}

/**
 * Dispatch an `/auth/*` request. Returns false if this is not one of ours, so the caller can fall
 * through to the SPA — which is what keeps browser-MSAL's `/auth/callback` route working.
 */
export async function handleAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  rawUrl: string,
): Promise<boolean> {
  if (cfg.authMode !== 'bff') return false;
  const method = req.method ?? 'GET';
  const query = new URLSearchParams(rawUrl.slice(path.length).replace(/^\?/, ''));

  if (path === '/auth/login' && method === 'GET') {
    await handleLogin(req, res, query);
    return true;
  }
  if (path === '/auth/callback' && method === 'GET') {
    await handleCallback(req, res, query);
    return true;
  }
  if (path === '/auth/logout' && method === 'POST') {
    handleLogout(req, res, loadSession(req));
    return true;
  }
  if (path === '/auth/me' && method === 'GET') {
    // Deliberately `loadSession`, not `currentSession`: this is polled, and a refresh here would
    // rewrite the cookie on a request whose answer does not depend on the token being fresh.
    handleMe(res, loadSession(req));
    return true;
  }
  return false;
}
