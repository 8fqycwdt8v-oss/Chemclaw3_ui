/**
 * Token custody: which bearer a session's next request carries, and how it is renewed. One refresh
 * per session at a time, shared by every request that needs it. A refresh the provider refuses ends
 * the session; one it cannot answer leaves it alone. Tokens never leave this module except as the
 * bearer string handed to the proxy.
 */

import { log } from '../log.ts';
import { authEventRecorded } from '../metrics.ts';
import { IdpRejected, IdpUnavailable } from './oidc.ts';
import type { OidcClient } from './oidc.ts';
import type { Session, SessionStore } from './sessions.ts';

/** The session cannot continue: sign in again. It has already been removed. */
export class SessionEnded extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`session ended: ${reason}`);
    this.name = 'SessionEnded';
    this.reason = reason;
  }
}

export interface CustodyOptions {
  /** An access token with less than this left is renewed before use. */
  skewMs: number;
  /** After a failed refresh the provider is left alone this long. */
  retryBackoffMs: number;
  /** A backend 401 forces a refresh at most this often per session. */
  forcedRefreshMinIntervalMs: number;
}

export class Custody {
  private readonly store: SessionStore;
  private readonly oidc: OidcClient;
  private readonly options: CustodyOptions;
  private readonly now: () => number;

  constructor(
    store: SessionStore,
    oidc: OidcClient,
    options: CustodyOptions,
    now: () => number = Date.now,
  ) {
    this.store = store;
    this.oidc = oidc;
    this.options = options;
    this.now = now;
  }

  /**
   * The bearer to send for this session now.
   * @throws SessionEnded when it cannot be renewed and nothing valid is left.
   * @throws IdpUnavailable when it has expired and the provider cannot be asked.
   */
  async bearer(session: Session): Promise<string> {
    const remaining = session.accessExpiresAt - this.now();
    if (remaining > this.options.skewMs) return session.accessToken;

    if (!session.refreshToken) {
      if (remaining > 0) return session.accessToken;
      this.end(session, 'access token expired and no refresh token was issued');
    }
    // After a failed refresh the provider is left alone for a while. A token with life left carries
    // the request; one without is answered at once, so an outage costs one attempt per window and
    // not one per request wave.
    if (this.now() < session.refreshRetryAt) {
      if (remaining > 0) return session.accessToken;
      throw new IdpUnavailable('identity provider unavailable; retrying shortly');
    }

    await this.refresh(session);
    return session.accessToken;
  }

  /**
   * A fresh bearer after the backend refused `rejected`, or `null` when none can be had. Several
   * requests refused with the same token share one refresh; a token someone else already replaced
   * is simply handed back; and a refresh that did not help is not repeated at once.
   */
  async renewAfterRefusal(session: Session, rejected: string): Promise<string | null> {
    if (session.accessToken !== rejected) return session.accessToken;
    if (!session.refreshToken) return null;
    // A refresh already running is joined, not counted against the interval: that bound is on
    // starting a second one after the first did not help.
    if (!session.refreshing) {
      if (this.now() - session.forcedRefreshAt < this.options.forcedRefreshMinIntervalMs)
        return null;
      session.forcedRefreshAt = this.now();
    }
    try {
      await this.refresh(session);
    } catch (error) {
      if (error instanceof SessionEnded) return null;
      log.warn('refresh after a backend 401 failed', { reason: errorCode(error) });
      return null;
    }
    return session.accessToken === rejected ? null : session.accessToken;
  }

  private refresh(session: Session): Promise<void> {
    session.refreshing ??= this.run(session).finally(() => {
      session.refreshing = null;
    });
    return session.refreshing;
  }

  private async run(session: Session): Promise<void> {
    const refreshToken = session.refreshToken;
    if (!refreshToken) this.end(session, 'no refresh token');
    try {
      const fresh = await this.oidc.refresh(refreshToken);
      session.accessToken = fresh.accessToken;
      session.accessExpiresAt = fresh.expiresAt;
      // A provider that rotates sends a new one; one that does not leaves the old one valid.
      if (fresh.refreshToken) session.refreshToken = fresh.refreshToken;
      session.refreshRetryAt = 0;
      authEventRecorded('refresh');
    } catch (error) {
      authEventRecorded('refresh_failed');
      if (error instanceof IdpRejected) {
        log.warn('refresh refused; ending the session', { oauth_error: error.oauthError });
        this.end(session, error.oauthError);
      }
      session.refreshRetryAt = this.now() + this.options.retryBackoffMs;
      log.warn('refresh failed; keeping the session', { reason: errorCode(error) });
      // A token with life left carries the request; one without cannot.
      if (session.accessExpiresAt <= this.now()) {
        throw error instanceof IdpUnavailable ? error : new IdpUnavailable('refresh failed');
      }
    }
  }

  private end(session: Session, reason: string): never {
    this.store.delete(session.id);
    authEventRecorded('session_ended');
    throw new SessionEnded(reason);
  }
}

const errorCode = (error: unknown): string =>
  error instanceof IdpRejected ? error.oauthError : error instanceof Error ? error.name : 'error';
