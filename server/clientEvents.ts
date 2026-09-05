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
import { cfg } from './config.ts';
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

/**
 * How many batches this process will write per minute, whoever sends them.
 *
 * **Measured before this existed**: twenty concurrent clients posting maximum-size batches for
 * three seconds had 1,297 accepted, writing 24,643 log entries and ~94 MB — about 31 MB/s, from
 * an unauthenticated route, from anything that can open a socket to the pod. The handler bounded
 * the *shape* of an entry (a 64 KiB body, 50 entries, 512-character messages) and nothing bounded
 * the *rate*, which on a cluster with log shipping is node-disk fill and unbounded ingest cost.
 *
 * The number is chosen against the sink's own cadence rather than picked round: `src/lib/logger.ts`
 * flushes at most every `FLUSH_INTERVAL_MS` (5 s), so a chemist's browser costs ~12 batches a
 * minute, with the ceiling scaling by replica because each pod holds its own.
 *
 * **It was 600, which is ~50 concurrent browsers, against a deployment target of 200.** At the
 * target the arithmetic above is 2,400 batches a minute, so three of every four were refused —
 * browser-side diagnostics thinning by 4x at exactly the moment something is wrong at scale, and
 * 40 req/s of this pod spent writing the refusals. The default is now that arithmetic plus
 * headroom (`server/config.ts`), and it is read from the config rather than fixed here: the knob
 * `CLIENT_EVENTS_RATE_PER_MIN` existed all along and had no reader, so a deployment that raised it
 * changed nothing. The worst case it admits is 3,000 × 64 KiB ≈ 3.2 MB/s, an order below the
 * 31 MB/s measured above, which is the point.
 *
 * **There is no per-address bucket, and that is a measurement rather than an omission.** One was
 * written first, at 60/min keyed on `req.socket.remoteAddress`. In this deployment the UI pod sits
 * behind an OpenShift route, so every browser's batches arrive from the router's address and the
 * per-address ceiling becomes a *global* one ten times stricter than the one below: driven with
 * 120 batches from a single address — ten chemists at the sink's own cadence, well inside the
 * process budget — it accepted 60 and refused 60. Nothing in this process establishes a trusted
 * forwarding header (`server/proxy.ts` strips client-supplied `x-chemclaw-*` and reads no
 * `X-Forwarded-For`), so there is no honest per-client key to bucket on, and a second limit that
 * cannot see clients is a limit that only refuses real ones.
 *
 * A refusal is a 429 the caller can read, not a closed socket: the browser sink treats a non-2xx
 * as a reason to back off and honours the `Retry-After` below (see `startClientEventSink`), and it
 * recovers when the pressure passes. Refusals need no counter of their own — `observe` in
 * `server/app.ts` books every response, so they are already
 * `chemclaw_ui_requests_total{route="/api/client-events",status="429"}`.
 */
const PROCESS_BATCHES_PER_MINUTE = cfg.clientEventsRatePerMin;
const BUDGET_WINDOW_MS = 60_000;

/**
 * The batches charged in the window that ends at `resetAt`.
 *
 * A fixed window rather than a sliding log: a sliding window keeps a timestamp per request, which
 * is the unbounded allocation this bound exists to prevent — and with one counter for the whole
 * process, there is nothing to sweep and no map to grow.
 */
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

  // Charged before the body is read, so a refused caller cannot make this process buffer 64 KiB
  // per attempt just by being over its limit. The refusal is written FIRST and the still-arriving
  // body hung up on afterwards, exactly as the 413 below does it: destroying the request instead
  // of answering takes the socket with it, and the browser reads a network error rather than the
  // `Retry-After` its sink is waiting for.
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
    // `debug` has its own arm, and the ternary that lacked one is why it mattered: `LEVELS` admits
    // `debug`, so a chemist on `?debug=1` had every debug line written at INFO — through the one
    // knob (`LOG_LEVEL`) an operator would reach for to make it stop.
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
