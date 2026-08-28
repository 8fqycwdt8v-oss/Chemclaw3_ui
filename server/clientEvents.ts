/**
 * `POST /api/client-events` — the sink for what the browser recorded.
 *
 * Every failure this SPA knows about used to die in the browser: a render error reached one
 * `console.error`, an unhandled rejection reached nothing at all, and roughly thirty deliberate
 * silent catches recorded nothing anywhere. `src/lib/logger.ts` is the browser half; this is where
 * the batches land.
 *
 * **The BFF logs them itself.** The Chemclaw service has no client-event route — there is nothing
 * to forward to — so a batch becomes one JSON line per entry in this pod's log, beside the access
 * log and in the same shape as the service's own records. If the service ever grows such a route,
 * the change here is to proxy instead, and the browser half does not move.
 *
 * **This route is answered here and is never proxied.** `server/routes.ts` is the list of paths
 * forwarded upstream and this is not one of them, which is why it is handled before that check
 * rather than added to the list.
 *
 * It is also the only route in this process that accepts a body it will *write down*, so the
 * hardening is about log integrity rather than about the backend:
 *
 *  - a body cap far below the proxy's, because a log line is not a payload;
 *  - a bound on entries per batch and on the length of each field;
 *  - control characters stripped, so nothing can forge a second line or a second JSON object;
 *  - the whole record emitted as JSON with the client's text as a *value*, never interpolated;
 *  - `source: "browser"` on every one, so a log query can tell what this pod observed from what a
 *    browser told it. These entries are unauthenticated by construction — the page that sends them
 *    is served before sign-in — and must never be read as this process's own testimony.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from './log.ts';

/** Much smaller than `maxBodyBytes`: twenty log entries do not need two megabytes. */
const MAX_BODY_BYTES = 64 * 1024;

/** Entries written per batch. The browser's own batch size is 20; this is the ceiling on it. */
const MAX_ENTRIES = 50;

/** Longest string written from any single field. */
const MAX_FIELD = 512;

const LEVELS = new Set(['error', 'warn', 'info', 'debug']);

/**
 * One field, as text safe to put in a log record.
 *
 * Control characters go first: a newline in a "message" is how a client forges a second line in a
 * line-delimited log, and it is worth removing even though every value here ends up JSON-encoded.
 */
const clean = (value: unknown, limit = MAX_FIELD): string =>
  String(value ?? '')
    // eslint-disable-next-line no-control-regex -- the control characters ARE the point.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, limit);

/**
 * The caller's own fields, bounded in every direction.
 *
 * Kept because they are the useful half — a status, a tool name, an attempt count — and
 * bounded because they arrive from an unauthenticated page: at most `MAX_CONTEXT_KEYS` keys,
 * primitives only, each stringified and cut. A nested object would let one entry carry a whole
 * document into a single log line.
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
 * Read at most `MAX_BODY_BYTES`. Resolves `null` when the body was over the cap.
 *
 * It does NOT destroy the request on the way past the cap, and that is the difference between a
 * 413 the caller reads and a connection reset it cannot interpret: destroying the request takes
 * the socket with it, so the response explaining the refusal never leaves. The caller writes the
 * 413 first and hangs up afterwards, exactly as `proxy.ts::refuseTooLarge` does.
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

/** Accept one batch. Always 204 on success — the browser has nothing to do with a reply. */
export async function handleClientEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
    res.end('{"detail":"method not allowed"}');
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
    const emit = entry.level === 'error' ? log.error : entry.level === 'warn' ? log.warn : log.info;
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
