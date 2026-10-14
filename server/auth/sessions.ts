/**
 * Server-side sessions and half-finished sign-ins, held in this process's memory.
 *
 * A session is the only place a token exists: the browser holds an opaque random id and nothing
 * else. Memory is a choice, not an oversight (docs/operations.md, "Token custody"): single-flight
 * refresh and revocation are trivial in one process, nothing outlives a restart that should not,
 * and the cost — a replica that has not seen a session does not know it — is met by session
 * affinity at the router; a miss sends the browser through a silent sign-in.
 *
 * Bounded everywhere: sessions by count (least recently used dropped), idle and absolute lifetime;
 * pending sign-ins by count and TTL. An unauthenticated caller can create the latter, so they are
 * the ones that must not grow without limit.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AccountView } from '../../shared/auth.ts';

/** 256 random bits as base64url: a session id, a binding, a state, a nonce. */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Constant-time equality of two strings of any length (their digests are compared). */
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

export interface Session {
  readonly id: string;
  readonly createdAt: number;
  lastSeenAt: number;
  readonly account: AccountView;
  accessToken: string;
  /** Epoch ms at which `accessToken` stops being accepted. */
  accessExpiresAt: number;
  /** Absent when the provider issued none: the session then ends with its access token. */
  refreshToken: string | null;
  /** The refresh in flight, shared by every request that needs one (single-flight). */
  refreshing: Promise<void> | null;
  /** No new refresh is attempted before this time after a transient failure. */
  refreshRetryAt: number;
  /** When a 401 from the backend last forced a refresh; bounds how often one can. */
  forcedRefreshAt: number;
}

export interface SessionLimits {
  idleMs: number;
  maxAgeMs: number;
  maxSessions: number;
}

export interface NewSession {
  account: AccountView;
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string | null;
}

export class SessionStore {
  /** Insertion order is recency order: a touched session is re-inserted at the end. */
  private readonly sessions = new Map<string, Session>();
  private readonly sweeper: NodeJS.Timeout;
  private readonly limits: SessionLimits;
  private readonly now: () => number;

  constructor(limits: SessionLimits, now: () => number = Date.now) {
    this.limits = limits;
    this.now = now;
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  get size(): number {
    return this.sessions.size;
  }

  /** A new session under a fresh id. Never reuses an id the caller supplied (fixation). */
  create(fresh: NewSession): Session {
    const at = this.now();
    const session: Session = {
      id: randomToken(),
      createdAt: at,
      lastSeenAt: at,
      account: fresh.account,
      accessToken: fresh.accessToken,
      accessExpiresAt: fresh.accessExpiresAt,
      refreshToken: fresh.refreshToken,
      refreshing: null,
      refreshRetryAt: 0,
      forcedRefreshAt: 0,
    };
    this.sessions.set(session.id, session);
    while (this.sessions.size > this.limits.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    return session;
  }

  /** The live session for an id, marked as used; `undefined` if unknown or past a lifetime. */
  get(id: string): Session | undefined {
    if (!id) return undefined;
    const session = this.sessions.get(id);
    if (!session) return undefined;
    const at = this.now();
    if (this.expired(session, at)) {
      this.sessions.delete(id);
      return undefined;
    }
    session.lastSeenAt = at;
    this.sessions.delete(id);
    this.sessions.set(id, session);
    return session;
  }

  delete(id: string): Session | undefined {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    return session;
  }

  /** Drop every expired session. Run on a timer and by tests. */
  sweep(): void {
    const at = this.now();
    for (const [id, session] of this.sessions) {
      if (this.expired(session, at)) this.sessions.delete(id);
    }
  }

  stop(): void {
    clearInterval(this.sweeper);
  }

  private expired(session: Session, at: number): boolean {
    return (
      at - session.lastSeenAt > this.limits.idleMs || at - session.createdAt > this.limits.maxAgeMs
    );
  }
}

/** What a sign-in remembers between sending the browser away and its coming back. */
export interface PendingLogin {
  verifier: string;
  nonce: string;
  returnTo: string;
  /** SHA-256 of the binding cookie's value: the browser that began this is the one that finishes it. */
  bindingDigest: Buffer;
  expiresAt: number;
}

export class PendingLogins {
  private readonly pending = new Map<string, PendingLogin>();
  private readonly ttlMs: number;
  private readonly maxPending: number;
  private readonly now: () => number;

  constructor(ttlMs: number, maxPending: number, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.maxPending = maxPending;
    this.now = now;
  }

  get size(): number {
    return this.pending.size;
  }

  /** Remember a sign-in under `state`; the oldest are forgotten over the cap. */
  add(
    state: string,
    login: Omit<PendingLogin, 'expiresAt' | 'bindingDigest'>,
    binding: string,
  ): void {
    this.sweep();
    this.pending.set(state, {
      ...login,
      bindingDigest: sha256(binding),
      expiresAt: this.now() + this.ttlMs,
    });
    while (this.pending.size > this.maxPending) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }

  /**
   * Take a sign-in out for use: single-use (a replayed callback finds nothing), and only for the
   * browser whose binding matches. A mismatch still consumes it — the state is spent either way.
   */
  take(state: string, binding: string): PendingLogin | undefined {
    const login = this.pending.get(state);
    this.pending.delete(state);
    if (!login || login.expiresAt < this.now()) return undefined;
    if (!binding || !timingSafeEqual(login.bindingDigest, sha256(binding))) return undefined;
    return login;
  }

  sweep(): void {
    const at = this.now();
    for (const [state, login] of this.pending) {
      if (login.expiresAt < at) this.pending.delete(state);
    }
  }
}
