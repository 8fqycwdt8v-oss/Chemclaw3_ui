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
 * How the sink waits out a failing endpoint, and the ceiling on that wait.
 *
 * A sink that retries a broken endpoint on every flush is the defect this module exists to report,
 * one layer down — and it cannot log its own failure without recursing. The first answer to that
 * was a latch: three consecutive non-2xx responses and the transport gave up **for the life of the
 * page**. That is the wrong shape for a diagnostic channel, and the arithmetic says why. The BFF
 * refuses a batch with a 429 when the pod is over its per-minute budget
 * (`server/clientEvents.ts`), a rolling restart answers a few requests with a 502, and either is
 * three responses in fifteen seconds at the sink's own cadence — after which a chemist's browser
 * reported nothing for the rest of the session, silently, exactly when something was wrong enough
 * to be worth reporting. Recovery was a page reload nobody knew to do.
 *
 * So: exponential backoff, capped, and it recovers. Five seconds, then 10, 20, 40 … to five
 * minutes, reset by the first success. A `Retry-After` on the response wins when it asks for
 * longer, because the server saying when to come back is better information than a doubling
 * client's guess.
 */
const SINK_BACKOFF_BASE_MS = 5_000;
const SINK_BACKOFF_MAX_MS = 300_000;

/**
 * Entries held while the sink is backed off, oldest dropped first.
 *
 * The backoff is what makes this bound necessary: a page that keeps logging through a five-minute
 * wait would otherwise grow the queue without limit, which is the failure mode `RING_SIZE` already
 * refuses for the ring buffer. Dropping the oldest is the right end to drop from — the entries
 * around the current failure are the ones somebody will read.
 */
const MAX_QUEUED_ENTRIES = 500;

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
  /**
   * Whatever the call site had that a reader would need.
   *
   * This said "never PII by construction: call sites pass ids, statuses and counts, never message
   * text", and no construction enforced any of it — the type is `Record<string, unknown>`, and
   * every call site that reports a *thrown* error passes that error's own message: `ErrorBoundary`
   * (`error.message`), both global handlers in `main.tsx` (`String(reason)`, `event.message`), and
   * `api/client.ts` (`auth.token_acquisition_failed`). Those strings come from wherever the throw
   * did, so an entry *can* carry text this rule says it cannot — and the set grows whenever
   * somebody reports a new failure, which is the other reason the claim could not hold. Deleting
   * it rather than the fields is deliberate: an unhandled rejection with its message removed is a
   * log line that says something broke and refuses to say what, which is the state this module was
   * written to end.
   *
   * What is true is a convention, and it is on the call site: pass ids, statuses, counts and
   * enumerable reasons; never the transcript, a draft, a token, a cookie or an address. Whatever
   * is passed leaves the browser (`startClientEventSink`) and is written into the UI pod's log by
   * `server/clientEvents.ts`, which bounds and de-controls it but cannot know what it means.
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
  /** Consecutive failures. Only ever sets how long to wait; it can no longer stop the sink. */
  let failures = 0;
  /** Nothing is posted before this instant. `0` is "now", which is the ordinary state. */
  let nextAttemptAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const url = `${config.apiBase.replace(/\/$/, '')}/client-events`;

  const backOff = (retryAfterSeconds: number): void => {
    failures += 1;
    const doubling = Math.min(SINK_BACKOFF_BASE_MS * 2 ** (failures - 1), SINK_BACKOFF_MAX_MS);
    // The server's own number wins when it asks for longer — a 429 from the BFF's per-minute
    // budget knows when the window turns over and this client does not — and is still capped, so
    // a hostile or mistaken header cannot silence the sink for the rest of the day.
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
   * Put a refused batch back at the front of the queue, oldest first out under the bound.
   *
   * The batch used to be dropped on failure, which combined with the latch meant a transient blip
   * cost both the entries in flight and every entry after them. Holding them is what makes the
   * backoff worth having: when the endpoint comes back, what was recorded during the outage is
   * still there to send.
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
    // At most `BATCH_SIZE` per POST, even when a backoff has left hundreds queued, and this is
    // the constraint the requeue above would otherwise break in two ways at once: `keepalive`
    // requests are capped at 64 KiB by the browser (an oversized body is rejected, so the batch
    // would fail for ever), and the BFF writes only the first `MAX_ENTRIES` (50) of a batch, so
    // everything past that would be dropped in silence at the far end.
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
