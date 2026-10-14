/**
 * Server-side sessions, in this process's memory: the only place a token exists. The browser holds
 * an opaque random id. Bounded by count (least recently used dropped) and by idle and absolute
 * lifetime. Ending a session, however it ends, also ends the live requests made under it.
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
  /** Ends of the live requests made under this session; run when it ends. */
  readonly watchers: Set<() => void>;
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
      watchers: new Set(),
    };
    this.sessions.set(session.id, session);
    while (this.sessions.size > this.limits.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
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
      this.delete(id);
      return undefined;
    }
    session.lastSeenAt = at;
    // Re-inserted at the end (recency order), which is not an end of the session.
    this.sessions.delete(id);
    this.sessions.set(id, session);
    return session;
  }

  /** Register the end of a live request made under `session`; returns how to withdraw it. */
  watch(session: Session, end: () => void): () => void {
    // A session already gone ends the request at once rather than never.
    if (this.sessions.get(session.id) !== session) {
      end();
      return () => undefined;
    }
    session.watchers.add(end);
    return () => session.watchers.delete(end);
  }

  /** End a session and every live request made under it. */
  delete(id: string): Session | undefined {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    if (session) {
      const ends = [...session.watchers];
      session.watchers.clear();
      for (const end of ends) end();
    }
    return session;
  }

  /** Drop every expired session. Run on a timer and by tests. */
  sweep(): void {
    const at = this.now();
    for (const [id, session] of this.sessions) {
      if (this.expired(session, at)) this.delete(id);
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

/**
 * The states whose callback has been taken, so a sealed login cookie replayed within its life finds
 * its state spent. Bounded and expiring; evicting the oldest only matters to an attacker who
 * already holds a sealed cookie *and* the provider's single-use code.
 */
export class SpentStates {
  private readonly spent = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(ttlMs: number, max: number, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.now = now;
  }

  /** Mark `state` spent; false if it already was. */
  spend(state: string): boolean {
    const key = createHash('sha256').update(state).digest('base64url');
    const at = this.now();
    for (const [k, until] of this.spent) {
      if (until >= at) break;
      this.spent.delete(k);
    }
    if (this.spent.has(key)) return false;
    this.spent.set(key, at + this.ttlMs);
    while (this.spent.size > this.max) {
      const oldest = this.spent.keys().next().value;
      if (oldest === undefined) break;
      this.spent.delete(oldest);
    }
    return true;
  }
}
