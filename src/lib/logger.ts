/**
 * The client-side record: what happened in this browser, kept where support can read it back.
 *
 * - A level from `/config.js` (`logLevel`), with a per-browser `?debug=1` override (remembered in
 *   `localStorage`).
 * - A ring buffer of the last `RING_SIZE` entries, for the crash screen to offer for pasting.
 * - A batched sink to the BFF, started explicitly by `main.tsx` (not on import, so unit tests never
 *   post).
 *
 * The console is mirrored only at `debug`.
 */

import { config } from '../env.ts';

export const LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LEVELS)[number];

/** Levels a caller can actually emit at — `silent` is a threshold, never an entry. */
export type EmitLevel = Exclude<LogLevel, 'silent'>;

/** Where a per-session override is remembered, so a reload keeps support's switch on. */
const OVERRIDE_KEY = 'chemclaw3.logLevel';

/** How many entries the crash screen can hand back. Bounded: this is memory in a long-lived tab. */
const RING_SIZE = 200;

/** Entries per POST, and the ceiling that forces an early flush. */
const BATCH_SIZE = 20;

/** How long a queued entry waits for company before it is sent anyway. */
const FLUSH_INTERVAL_MS = 5_000;

/**
 * The sink's backoff on a failing endpoint: 5 s doubling to 5 min, reset by the first success; a
 * longer `Retry-After` wins. It always recovers — a 429 or a rolling restart must not silence a
 * browser for the rest of the session.
 */
const SINK_BACKOFF_BASE_MS = 5_000;
const SINK_BACKOFF_MAX_MS = 300_000;

/**
 * Entries held while backed off, oldest dropped first, so a long outage cannot grow the queue
 * without bound.
 */
const MAX_QUEUED_ENTRIES = 500;

export interface LogEntry {
  /** ISO-8601, so an entry lines up with the backend's own JSON records without a parse guess. */
  ts: string;
  level: EmitLevel;
  /** A short, stable, greppable event name — `turn.timing`, not a sentence. */
  message: string;
  /** The turn this entry belongs to, or empty. */
  correlationId: string;
  /** The backend session this entry belongs to, when one was known. */
  sessionId: string;
  /**
   * Whatever the call site had that a reader needs. Convention, not enforcement: pass ids,
   * statuses, counts and enumerable reasons — never the transcript, a draft, a token, a cookie or
   * an address. Thrown errors' messages are included. Everything here leaves the browser and lands
   * in the UI pod's log (`server/clientEvents.ts`).
   */
  context?: Record<string, unknown>;
}

const RANK: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

const readOverride = (): LogLevel | null => {
  try {
    const stored = window.localStorage.getItem(OVERRIDE_KEY);
    return stored && stored in RANK ? (stored as LogLevel) : null;
  } catch {
    // A browser with site data blocked. The configured level still applies.
    return null;
  }
};

/** Apply `?debug=1` / `?debug=0` and return the level in force; `0` clears the override. */
function resolveLevel(): LogLevel {
  if (typeof window !== 'undefined') {
    try {
      const flag = new URLSearchParams(window.location.search).get('debug');
      if (flag === '1') window.localStorage.setItem(OVERRIDE_KEY, 'debug');
      else if (flag === '0') window.localStorage.removeItem(OVERRIDE_KEY);
    } catch {
      // No storage, or a URL we cannot parse. Fall through to the configured level.
    }
    const override = readOverride();
    if (override) return override;
  }
  return config.logLevel;
}

const level: LogLevel = resolveLevel();

/** The identifiers every subsequent entry is stamped with, until they are replaced. */
let context: { correlationId: string; sessionId: string } = { correlationId: '', sessionId: '' };

const ring: LogEntry[] = [];

/** Queued for the sink. Separate from the ring: the ring is a window, this is a work list. */
let queue: LogEntry[] = [];

let sink: ((entries: LogEntry[]) => void) | null = null;

function emit(entryLevel: EmitLevel, message: string, ctx?: Record<string, unknown>): void {
  if (RANK[entryLevel] > RANK[level]) return;

  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level: entryLevel,
    message,
    correlationId: context.correlationId,
    sessionId: context.sessionId,
    ...(ctx && Object.keys(ctx).length > 0 ? { context: ctx } : {}),
  };

  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();

  if (level === 'debug') {
    // Only at `debug`, and only through one call: see the module docstring.
    const line = `[chemclaw:${entryLevel}] ${message}`;
    if (entryLevel === 'error' || entryLevel === 'warn') console.error(line, ctx ?? '');
    else console.log(line, ctx ?? '');
  }

  sink?.([entry]);
}

export const logger = {
  error: (message: string, ctx?: Record<string, unknown>): void => emit('error', message, ctx),
  warn: (message: string, ctx?: Record<string, unknown>): void => emit('warn', message, ctx),
  info: (message: string, ctx?: Record<string, unknown>): void => emit('info', message, ctx),
  debug: (message: string, ctx?: Record<string, unknown>): void => emit('debug', message, ctx),

  /** The level actually in force, after the per-session override. */
  level: (): LogLevel => level,

  /**
   * Stamp subsequent entries with the current turn and session, which most call sites cannot know.
   */
  setContext(next: Partial<{ correlationId: string; sessionId: string }>): void {
    context = { ...context, ...next };
  },

  /** The turn id the crash screen shows, and the one every entry is stamped with. */
  correlationId: (): string => context.correlationId,

  /** The last `RING_SIZE` entries, newest last. A copy: a caller must not be able to edit it. */
  snapshot: (): LogEntry[] => [...ring],
};

/**
 * Everything a support conversation needs, as pasteable text: readable header lines, then the
 * entries.
 */
export function diagnosticsText(): string {
  const header = [
    `chemclaw3-ui ${config.appVersion}`,
    `time ${new Date().toISOString()}`,
    `reference ${context.correlationId || '(none)'}`,
    `session ${context.sessionId || '(none)'}`,
    `agent ${typeof navigator === 'undefined' ? '(unknown)' : navigator.userAgent}`,
    '',
  ];
  const entries = ring.map(
    (e) =>
      `${e.ts} ${e.level.toUpperCase()} ${e.message}` +
      (e.correlationId ? ` [${e.correlationId}]` : '') +
      (e.context ? ` ${JSON.stringify(e.context)}` : ''),
  );
  return [...header, ...entries].join('\n');
}

/**
 * Start batching entries to `POST {apiBase}/client-events`, the BFF's own route (logged in the UI
 * pod). Called once from `main.tsx`; returns a stop function for tests.
 */
export function startClientEventSink(): () => void {
  /** Consecutive failures; only sets the wait. */
  let failures = 0;
  /** Nothing is posted before this instant. `0` is "now", which is the ordinary state. */
  let nextAttemptAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const url = `${config.apiBase.replace(/\/$/, '')}/client-events`;

  const backOff = (retryAfterSeconds: number): void => {
    failures += 1;
    const doubling = Math.min(SINK_BACKOFF_BASE_MS * 2 ** (failures - 1), SINK_BACKOFF_MAX_MS);
    // A longer server `Retry-After` wins, still capped.
    const asked = Math.min(retryAfterSeconds * 1_000, SINK_BACKOFF_MAX_MS);
    nextAttemptAt = Date.now() + Math.max(doubling, asked);
  };

  const send = (entries: LogEntry[]): void => {
    if (entries.length === 0) return;
    const body = JSON.stringify({
      app_version: config.appVersion,
      // Once per batch rather than once per entry: it is constant for the page, and repeating it
      // twenty times per POST is bytes nobody reads.
      user_agent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
      entries,
    });
    // `keepalive` so a batch flushed from `pagehide` survives the navigation that triggered it.
    void fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
      cache: 'no-store',
    })
      .then((res) => {
        if (res.ok) {
          failures = 0;
          nextAttemptAt = 0;
          return;
        }
        const retryAfter = Number(res.headers.get('retry-after') ?? '');
        backOff(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0);
        requeue(entries);
      })
      .catch(() => {
        // Never logged: reporting a reporting failure through the logger is a loop, and the ring
        // buffer is what the crash screen shows anyway.
        backOff(0);
        requeue(entries);
      });
  };

  /**
   * Put a refused batch back at the front of the queue so entries from an outage are sent once the
   * endpoint returns.
   */
  const requeue = (entries: LogEntry[]): void => {
    queue = [...entries, ...queue].slice(-MAX_QUEUED_ENTRIES);
    schedule(Math.max(0, nextAttemptAt - Date.now()));
  };

  const schedule = (delay: number): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, delay);
  };

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (queue.length === 0) return;
    const wait = nextAttemptAt - Date.now();
    if (wait > 0) {
      // Backed off: hold what is queued (bounded) and come back when the wait is over, rather
      // than posting into an endpoint that has just refused and burning the next attempt.
      queue = queue.slice(-MAX_QUEUED_ENTRIES);
      schedule(wait);
      return;
    }
    // At most `BATCH_SIZE` per POST: `keepalive` bodies are capped at 64 KiB, and the BFF keeps
    // only the first 50 entries of a batch.
    const batch = queue.slice(0, BATCH_SIZE);
    queue = queue.slice(BATCH_SIZE);
    send(batch);
    // A backlog drains at the sink's ordinary cadence rather than as a burst of parallel POSTs
    // into an endpoint that has only just recovered.
    if (queue.length > 0) schedule(FLUSH_INTERVAL_MS);
  };

  sink = (entries) => {
    queue.push(...entries);
    if (queue.length >= BATCH_SIZE) {
      flush();
      return;
    }
    if (!timer) timer = setTimeout(flush, FLUSH_INTERVAL_MS);
  };

  const onHide = (): void => {
    if (document.visibilityState === 'hidden') flush();
  };

  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', onHide);

  return () => {
    window.removeEventListener('pagehide', flush);
    document.removeEventListener('visibilitychange', onHide);
    flush();
    // A backed-off flush re-arms the timer; a stopped sink must not leave one running to post
    // into a page that has torn its transport down.
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    sink = null;
  };
}
