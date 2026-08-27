/**
 * The client-side record: what happened in this browser, kept where somebody can read it back.
 *
 * Error *handling* in this app is careful — every failure has a typed kind, a banner and a
 * recovery. Error *reporting* did not exist: an `ErrorBoundary` `console.error`, ~30 deliberate
 * silent catches (one of which says in a comment "not worth a banner, but worth saying somewhere"
 * and then said it nowhere), and no global handler at all, so an unhandled rejection anywhere in
 * the app was invisible to everyone but the one chemist watching it fail. This module is the
 * "somewhere".
 *
 * Three parts, each with a reason for being separate:
 *
 *  - **A level and a per-session override.** `logLevel` is served by `/config.js`, so a tenant's
 *    verbosity is a deployment setting rather than a rebuild; `?debug=1` (persisted for the tab's
 *    browser under `localStorage`) turns one chemist's browser verbose without a redeploy, which
 *    is what support actually needs when a single user is the one seeing it.
 *  - **A ring buffer.** The last `RING_SIZE` entries, in memory, so the crash screen can hand the
 *    reader something to paste. It costs nothing and it is the only artefact available when the
 *    network is the thing that broke.
 *  - **A batched sink**, installed explicitly by `main.tsx` rather than on import. That is
 *    deliberate: a module-scope sink would make every unit test in this repository issue
 *    background POSTs into whatever `fetch` stub the test had installed, so the transport is
 *    started by the application and nowhere else.
 *
 * The console is mirrored ONLY at `debug`. Existing `console.*` calls in this codebase are all
 * deliberate and commented, and adding a second copy of every warning to the console would drown
 * them — the record lives in the buffer and at the sink, which is where a support conversation can
 * reach it.
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
 * Consecutive sink failures after which the transport gives up for the life of the page.
 *
 * A sink that retries a broken endpoint forever is the same defect this module exists to report,
 * one layer down — and it cannot log its own failure without recursing.
 */
const MAX_SINK_FAILURES = 3;

export interface LogEntry {
  /** ISO-8601, so an entry lines up with the backend's own JSON records without a parse guess. */
  ts: string;
  level: EmitLevel;
  /** A short, stable, greppable event name — `turn.timing`, not a sentence. */
  message: string;
  /** The turn this entry belongs to, when one was known. Empty is honest, not a placeholder. */
  correlationId: string;
  /** The backend session this entry belongs to, when one was known. */
  sessionId: string;
  /** Whatever the call site had that a reader would need. Never PII by construction: call sites
   *  pass ids, statuses and counts, never message text. */
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

/**
 * Apply `?debug=1` / `?debug=0` if present, and report the level now in force.
 *
 * Reading the query string here rather than in `main.tsx` keeps the whole switch in one file: the
 * flag, where it is remembered, and what reads it. `?debug=0` clears the override rather than
 * pinning a level, so the deployment's own setting comes back.
 */
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
   * Stamp subsequent entries with the turn and session they belong to.
   *
   * Held here rather than passed at every call site because the correlation id is exactly the
   * thing most call sites do not have — a silent catch in the sidebar cannot know which turn is
   * running, and the whole point of the id is that everything from one turn carries it.
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
 * Everything a support conversation needs, as text a chemist can paste.
 *
 * Deliberately not JSON-only: the header lines are what makes it readable in a chat message, and
 * the entries below are what makes it useful to whoever reads the logs afterwards.
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
 * Start batching entries to `POST {apiBase}/client-events`.
 *
 * Called once, from `main.tsx`. Returns a stop function — used by the test that proves the
 * batching, and by nothing in the application, which runs one sink for the life of the page.
 *
 * The endpoint is the BFF's own: it is not proxied upstream (the Chemclaw service has no such
 * route), so the batch is written to the UI pod's log where an operator is already looking.
 */
export function startClientEventSink(): () => void {
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const url = `${config.apiBase.replace(/\/$/, '')}/client-events`;

  const send = (entries: LogEntry[]): void => {
    if (entries.length === 0 || failures >= MAX_SINK_FAILURES) return;
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
        failures = res.ok ? 0 : failures + 1;
      })
      .catch(() => {
        // Never logged: reporting a reporting failure through the logger is a loop, and the ring
        // buffer is what the crash screen shows anyway.
        failures += 1;
      });
  };

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    send(batch);
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
    sink = null;
  };
}
