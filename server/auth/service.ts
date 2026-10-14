/**
 * The BFF's sign-in routes (`/auth/*`) and the lookup that turns a cookie into a session.
 *
 * `login` and `callback` keep no server state for a sign-in: it rides in a sealed cookie
 * (`sealed.ts`). Only this module builds or reads the session cookie. Every response is
 * `no-store`; a failure is a small page with a way back in, the reason going to the log.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AUTH_PATHS, SIGNED_IN_MARKER, safeReturnTo } from '../../shared/auth.ts';
import type { LogoutView, SessionView } from '../../shared/auth.ts';
import { cfg } from '../config.ts';
import { log } from '../log.ts';
import { authEventRecorded } from '../metrics.ts';
import { clearCookie, cookieNames, readCookie, readSealedCookie, setCookie } from './cookies.ts';
import { Custody } from './custody.ts';
import { csrfRefusal } from './csrf.ts';
import { IdpRejected, IdpUnavailable, OidcClient } from './oidc.ts';
import { deriveKey, seal, tagOf, unseal } from './sealed.ts';
import { SessionStore, SpentStates, randomToken, sameSecret } from './sessions.ts';
import type { Session } from './sessions.ts';

/** Callbacks remembered as taken; bounded, and each expires with the cookie that carried it. */
const MAX_SPENT_STATES = 10_000;

/** Sign-ins in progress per browser (one cookie each, so several tabs can sign in at once). */
const MAX_LOGIN_COOKIES = 3;

/** A backend 401 forces a refresh at most this often for one session. */
const FORCED_REFRESH_MIN_INTERVAL_MS = 30_000;

const NO_STORE = { 'cache-control': 'no-store' } as const;

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The PKCE S256 challenge for a verifier. */
const challengeFor = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

/** `returnTo` with the marker the SPA reads once to tell a lost cookie from a first visit. */
function withMarker(returnTo: string): string {
  const hashAt = returnTo.indexOf('#');
  const hash = hashAt < 0 ? '' : returnTo.slice(hashAt);
  const path = hashAt < 0 ? returnTo : returnTo.slice(0, hashAt);
  return `${path}${path.includes('?') ? '&' : '?'}${SIGNED_IN_MARKER}=1${hash}`;
}

export class AuthService {
  readonly sessions: SessionStore;
  readonly custody: Custody;
  private readonly spent: SpentStates;
  private readonly oidc: OidcClient;
  private readonly key: Buffer;

  constructor() {
    this.sessions = new SessionStore({
      idleMs: cfg.sessionIdleMs,
      maxAgeMs: cfg.sessionMaxAgeMs,
      maxSessions: cfg.maxSessions,
    });
    this.spent = new SpentStates(cfg.loginStateTtlMs, MAX_SPENT_STATES);
    this.key = deriveKey(cfg.sessionKey);
    this.oidc = new OidcClient({
      authority: cfg.entraAuthority,
      clientId: cfg.entraClientId,
      clientSecret: cfg.entraClientAuth === 'secret' ? cfg.entraClientSecret : null,
      scope: `openid profile offline_access ${cfg.apiScope}`,
      redirectUri: `${cfg.appOrigin}${AUTH_PATHS.callback}`,
      postLogoutRedirectUri: `${cfg.appOrigin}/`,
      ...(cfg.entraIssuer ? { issuer: cfg.entraIssuer } : {}),
      endSession: cfg.endSessionEnabled,
      timeoutMs: cfg.oidcHttpTimeoutMs,
      endpointOrigins: cfg.entraEndpointOrigins,
    });
    this.custody = new Custody(this.sessions, this.oidc, {
      skewMs: cfg.tokenRefreshSkewMs,
      retryBackoffMs: cfg.tokenRefreshBackoffMs,
      forcedRefreshMinIntervalMs: FORCED_REFRESH_MIN_INTERVAL_MS,
    });
  }

  /** The session this request's cookie names, if it is still alive. */
  sessionFor(req: IncomingMessage): Session | undefined {
    return this.sessions.get(readCookie(req, cfg.sessionCookieName));
  }

  /** Whether a path belongs to this module. */
  static owns(path: string): boolean {
    return Object.values(AUTH_PATHS).includes(path as (typeof AUTH_PATHS)[keyof typeof AUTH_PATHS]);
  }

  /** Answer one `/auth/*` request. Resolves when the response is written. */
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    query: URLSearchParams,
    correlationId: string,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    const wanted = path === AUTH_PATHS.logout ? 'POST' : 'GET';
    if (method !== wanted) {
      res.writeHead(405, { ...NO_STORE, 'content-type': 'application/json', allow: wanted });
      res.end('{"detail":"method not allowed"}');
      return;
    }
    switch (path) {
      case AUTH_PATHS.login:
        return this.login(req, res, query, correlationId);
      case AUTH_PATHS.callback:
        return this.callback(req, res, query, correlationId);
      case AUTH_PATHS.session:
        return this.session(req, res);
      default:
        return this.logout(req, res);
    }
  }

  private loginCookie(tag: string): string {
    return `${cfg.loginCookieName}_${tag}`;
  }

  private loginCookieFlags = { secure: cfg.cookieSecure, sameSite: 'Lax' } as const;

  /**
   * Set-Cookie values that clear this browser's expired sign-in cookies and, past
   * `MAX_LOGIN_COOKIES`, its oldest, so a browser never accumulates them.
   */
  private tidyLoginCookies(req: IncomingMessage): string[] {
    const prefix = `${cfg.loginCookieName}_`;
    const live: { name: string; expiresAt: number }[] = [];
    const clear: string[] = [];
    for (const name of cookieNames(req, prefix)) {
      const login = unseal(readSealedCookie(req, name), name.slice(prefix.length), this.key);
      if (login) live.push({ name, expiresAt: login.expiresAt });
      else clear.push(name);
    }
    live.sort((a, b) => a.expiresAt - b.expiresAt);
    clear.push(
      ...live.slice(0, Math.max(0, live.length - (MAX_LOGIN_COOKIES - 1))).map((l) => l.name),
    );
    return clear.map((name) => clearCookie(name, this.loginCookieFlags));
  }

  private async login(
    req: IncomingMessage,
    res: ServerResponse,
    query: URLSearchParams,
    correlationId: string,
  ): Promise<void> {
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken();
    let location: string;
    try {
      location = await this.oidc.authorizeUrl({ state, nonce, challenge: challengeFor(verifier) });
    } catch (error) {
      this.fail(
        res,
        503,
        'Sign-in is unavailable',
        'The identity provider could not be reached.',
        correlationId,
        error,
      );
      return;
    }
    const sealed = seal(
      {
        state,
        nonce,
        verifier,
        returnTo: safeReturnTo(query.get('returnTo')),
        expiresAt: Date.now() + cfg.loginStateTtlMs,
      },
      this.key,
    );
    authEventRecorded('login_started');
    res.writeHead(302, {
      ...NO_STORE,
      location,
      'set-cookie': [
        ...this.tidyLoginCookies(req),
        // Lax: the provider's redirect back is a cross-site navigation and must carry it.
        setCookie(this.loginCookie(tagOf(state)), sealed, {
          ...this.loginCookieFlags,
          maxAgeSeconds: cfg.loginStateTtlMs / 1000,
        }),
      ],
    });
    res.end();
  }

  private async callback(
    req: IncomingMessage,
    res: ServerResponse,
    query: URLSearchParams,
    correlationId: string,
  ): Promise<void> {
    const state = query.get('state') ?? '';
    const tag = tagOf(state);
    const cookieName = this.loginCookie(tag);
    const loginCookie = clearCookie(cookieName, this.loginCookieFlags);
    const stored = unseal(readSealedCookie(req, cookieName), tag, this.key);
    // The cookie names this state, so only the browser that began the sign-in can present it; the
    // state is then spent, so the same cookie cannot be presented twice.
    const login =
      state && stored && sameSecret(stored.state, state) && this.spent.spend(state)
        ? stored
        : undefined;
    if (!login) {
      authEventRecorded('login_failed');
      this.fail(
        res,
        400,
        'Sign-in could not be completed',
        'This sign-in expired, was already used, or was not started in this browser.',
        correlationId,
        new Error('unknown, spent or unbound state'),
        loginCookie,
      );
      return;
    }
    const providerError = query.get('error');
    const code = query.get('code');
    if (providerError || !code) {
      authEventRecorded('login_failed');
      this.fail(
        res,
        403,
        'Sign-in was not completed',
        'The identity provider did not grant access.',
        correlationId,
        new Error(`provider error: ${(providerError ?? 'no code').slice(0, 64)}`),
        loginCookie,
      );
      return;
    }
    let session: Session | undefined;
    try {
      const tokens = await this.oidc.exchangeCode(code, login.verifier);
      if (!tokens.idToken) throw new IdpRejected('invalid_id_token', 'no ID token was issued');
      const account = await this.oidc.verifyIdToken(tokens.idToken, login.nonce);
      // A fresh id on every sign-in, and the previous session (if this browser had one) is gone:
      // an id set by anyone else never becomes an authenticated one.
      const previous = readCookie(req, cfg.sessionCookieName);
      if (previous) this.sessions.delete(previous);
      session = this.sessions.create({
        account,
        accessToken: tokens.accessToken,
        accessExpiresAt: tokens.expiresAt,
        refreshToken: tokens.refreshToken,
      });
      authEventRecorded('login_completed');
      log.info('signed in', { correlation_id: correlationId });
      res.writeHead(302, {
        ...NO_STORE,
        location: withMarker(login.returnTo),
        'set-cookie': [
          loginCookie,
          setCookie(cfg.sessionCookieName, session.id, {
            secure: cfg.cookieSecure,
            sameSite: 'Strict',
            maxAgeSeconds: cfg.sessionMaxAgeMs / 1000,
          }),
        ],
      });
      res.end();
    } catch (error) {
      // A session created for a response that could not be written would sit unclaimed.
      if (session) this.sessions.delete(session.id);
      authEventRecorded('login_failed');
      const unavailable = error instanceof IdpUnavailable;
      this.fail(
        res,
        unavailable ? 503 : 403,
        unavailable ? 'Sign-in is unavailable' : 'Sign-in was refused',
        unavailable
          ? 'The identity provider could not be reached.'
          : 'The identity provider’s answer could not be accepted.',
        correlationId,
        error,
        loginCookie,
      );
    }
  }

  private session(req: IncomingMessage, res: ServerResponse): void {
    const refusal = csrfRefusal(req, cfg.appOrigin, false);
    if (refusal) return this.refuse(res, refusal);
    const session = this.sessionFor(req);
    const body: SessionView = session
      ? { authenticated: true, account: session.account }
      : { authenticated: false };
    if (!session && readCookie(req, cfg.sessionCookieName)) authEventRecorded('session_missing');
    res.writeHead(200, { ...NO_STORE, 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const refusal = csrfRefusal(req, cfg.appOrigin);
    if (refusal) return this.refuse(res, refusal);
    const ended = this.sessions.delete(readCookie(req, cfg.sessionCookieName));
    if (ended?.refreshToken) {
      // Where the provider can revoke, the refresh token dies with the session. Not awaited: the
      // person is signing out, not waiting on a network call that is only best effort.
      void this.oidc.revoke(ended.refreshToken);
    }
    authEventRecorded('logout');
    const body: LogoutView = { endSessionUrl: await this.oidc.endSessionUrl() };
    res.writeHead(200, {
      ...NO_STORE,
      'content-type': 'application/json',
      'set-cookie': clearCookie(cfg.sessionCookieName, {
        secure: cfg.cookieSecure,
        sameSite: 'Strict',
      }),
    });
    res.end(JSON.stringify(body));
  }

  /** The 403 a cross-site request gets, from here or from the proxy. */
  refuse(res: ServerResponse, reason: string): void {
    authEventRecorded('csrf_refused');
    log.warn('refused a cross-site request', { reason });
    res.writeHead(403, { ...NO_STORE, 'content-type': 'application/json' });
    res.end('{"detail":"cross-site request refused","code":"csrf"}');
  }

  /** A page the person can read, with a way back in; the cause is logged, not shown. */
  private fail(
    res: ServerResponse,
    status: number,
    title: string,
    message: string,
    correlationId: string,
    cause: unknown,
    extraCookie?: string,
  ): void {
    log.warn('sign-in failed', {
      status,
      reason: cause instanceof Error ? cause.message : String(cause),
      correlation_id: correlationId,
    });
    const html =
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem}</style>' +
      `</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>` +
      `<p><a href="${AUTH_PATHS.login}">Try again</a></p>` +
      `<p><small>Reference ${escapeHtml(correlationId)}</small></p></body></html>`;
    res.writeHead(status, {
      ...NO_STORE,
      'content-type': 'text/html; charset=utf-8',
      ...(extraCookie ? { 'set-cookie': extraCookie } : {}),
    });
    res.end(html);
  }
}
