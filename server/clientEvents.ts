/**
 * `POST /api/client-events`: the sink for browser log batches (`src/lib/logger.ts`). The BFF writes
 * each entry as a JSON log line in this pod's log; it is never proxied.
 *
 * The one route that writes a request body to the log, so it is hardened for log integrity: a small
 * body cap, bounded entries and fields, control characters stripped, client text only as JSON
 * values, and `source: "browser"` on every record (unauthenticated input, never this process's
 * testimony).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { cfg } from './config.ts';
import { log } from './log.ts';

/** Much smaller than `maxBodyBytes`: twenty log entries do not need two megabytes. */
const MAX_BODY_BYTES = 64 * 1024;

/** Entries written per batch. The browser's own batch size is 20; this is the ceiling on it. */
const MAX_ENTRIES = 50;

/** Longest string written from any single field. */
const MAX_FIELD = 512;

const LEVELS = new Set(['error', 'warn', 'info', 'debug']);

/** One field as log-safe text: control characters removed (no forged lines), then length-capped. */
const clean = (value: unknown, limit = MAX_FIELD): string =>
  String(value ?? '')
    // eslint-disable-next-line no-control-regex -- the control characters ARE the point.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, limit);

/**
 * The caller's context fields, bounded: at most `MAX_CONTEXT_KEYS` keys, primitives only, each
 * stringified and cut.
 */
const MAX_CONTEXT_KEYS = 12;

const cleanContext = (value: unknown): Record<string, string> | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_CONTEXT_KEYS) break;
    if (item === null || typeof item === 'object') continue;
    out[clean(key, 40)] = clean(String(item), 200);
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

interface ClientEntry {
  level: string;
  message: string;
  correlationId: string;
  sessionId: string;
  ts: string;
  context: Record<string, string> | undefined;
}

function entriesFrom(body: unknown): { entries: ClientEntry[]; appVersion: string; agent: string } {
  const envelope = (typeof body === 'object' && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  const raw = Array.isArray(envelope.entries) ? envelope.entries.slice(0, MAX_ENTRIES) : [];
  const entries = raw.map((item): ClientEntry => {
    const e = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const level = clean(e.level, 8);
    return {
      level: LEVELS.has(level) ? level : 'info',
      message: clean(e.message),
      correlationId: clean(e.correlationId, 128),
      sessionId: clean(e.sessionId, 128),
      ts: clean(e.ts, 40),
      context: cleanContext(e.context),
    };
  });
  return {
    entries,
    appVersion: clean(envelope.app_version, 64),
    // Long, and worth keeping whole: "only in Safari 17" is a real answer and it lives here.
    agent: clean(envelope.user_agent, 256),
  };
}

/**
 * Read at most `MAX_BODY_BYTES`; `null` when over. Does not destroy the request, so the caller can
 * still write the 413.
 */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    let over = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        over = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => resolve(null));
  });
}

/**
 * Batches this process accepts per minute (`CLIENT_EVENTS_RATE_PER_MIN`), sized for the deployment
 * target at the browser sink's 5 s cadence plus headroom. Process-wide, with no per-address bucket:
 * behind the router every browser shares one address, and there is no trusted forwarding header.
 * Refusals are 429 with `Retry-After`, counted by the access metrics.
 */
const PROCESS_BATCHES_PER_MINUTE = cfg.clientEventsRatePerMin;
const BUDGET_WINDOW_MS = 60_000;

/** Batches charged in the current fixed window (one counter, nothing to grow). */
let budget = { count: 0, resetAt: 0 };

/** Whether this batch is within the budget, charging it when it is. */
function withinBudget(now: number): boolean {
  if (now >= budget.resetAt) budget = { count: 0, resetAt: now + BUDGET_WINDOW_MS };
  if (budget.count >= PROCESS_BATCHES_PER_MINUTE) return false;
  budget.count += 1;
  return true;
}

/** Test seam: the window is process-wide, so one test would otherwise spend another's budget. */
export function resetClientEventBudget(): void {
  budget = { count: 0, resetAt: 0 };
}

/** Accept one batch. Always 204 on success — the browser has nothing to do with a reply. */
export async function handleClientEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
    res.end('{"detail":"method not allowed"}');
    return;
  }

  // Charged before reading the body; the 429 is written first, then the remaining body hung up on.
  if (!withinBudget(Date.now())) {
    const retryAfter = Math.max(1, Math.ceil((budget.resetAt - Date.now()) / 1000));
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': String(retryAfter),
      connection: 'close',
    });
    res.end('{"detail":"too many client event batches"}');
    if (!req.readableEnded) req.destroy();
    return;
  }

  const body = await readBody(req);
  if (body === null) {
    res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
    res.end('{"detail":"request body too large"}');
    // And hang up on a body still arriving: answering early and then waiting politely for the
    // rest of a batch we have already refused is an unbounded hold on this process.
    if (!req.readableEnded) req.destroy();
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"detail":"invalid json"}');
    return;
  }

  const { entries, appVersion, agent } = entriesFrom(parsed);
  for (const entry of entries) {
    // `debug` entries are written at debug level, not info.
    const emit =
      entry.level === 'error'
        ? log.error
        : entry.level === 'warn'
          ? log.warn
          : entry.level === 'debug'
            ? log.debug
            : log.info;
    emit(entry.message, {
      source: 'browser',
      client_ts: entry.ts,
      correlation_id: entry.correlationId,
      session_id: entry.sessionId,
      app_version: appVersion,
      user_agent: agent,
      ...(entry.context ? { context: entry.context } : {}),
    });
  }

  res.writeHead(204);
  res.end();
}
