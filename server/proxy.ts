/**
 * The streaming reverse proxy to the Chemclaw service. `node:http.request`, not `fetch`/undici:
 * undici's default 300 s body idle timeout would kill a legitimately silent event stream, and
 * `http.request` gives piped backpressure with no dependency.
 *
 * The `Authorization` header is forwarded verbatim and never inspected; the backend validates it.
 */

import http from 'node:http';
import https from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { cfg } from './config.ts';
import { log } from './log.ts';
import { CORRELATION_HEADER, correlationFrom } from './correlation.ts';
import { upstreamErrorRecorded } from './metrics.ts';

/**
 * What one request tells the access log about itself, filled in as dispatch and the upstream answer
 * proceed, and written when the response closes. Lives here because `app.ts` imports this module.
 */
export interface RequestTrace {
  /**
   * The route template, never the matched path. Starts least specific and is narrowed during
   * dispatch.
   */
  route: string;
  /** Milliseconds from opening the upstream request to its response headers. Null if none came. */
  upstreamMs: number | null;
  /** This request's correlation id: minted at the front door, replaced by the service's own. */
  correlationId: string;
}

const upstream = new URL(cfg.apiUrl);
const transport = upstream.protocol === 'https:' ? https : http;

/**
 * The ordinary upstream pool: keep-alive with no socket timeout (a turn can be silent for its full
 * 600 s). Separate from the stream pool so held SSE streams cannot starve short calls;
 * `cfg.requestTimeoutMs` bounds slow request bodies holding sockets.
 */
const agent = new transport.Agent({
  keepAlive: true,
  keepAliveMsecs: 15_000,
  maxSockets: cfg.maxUpstreamSockets,
  timeout: 0,
});

/**
 * The pool for the turn stream and job push-back stream, sized by residency (one socket per turn or
 * tab).
 */
const streamAgent = new transport.Agent({
  keepAlive: true,
  keepAliveMsecs: 15_000,
  maxSockets: cfg.maxUpstreamStreamSockets,
  timeout: 0,
});

/** Headers that describe a single hop and must never be copied across one. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

/**
 * Response headers this process owns regardless of the upstream: a proxied response is a
 * same-origin document, so its CSP and `nosniff` are the SPA's.
 */
const BFF_OWNED = new Set([
  'content-security-policy',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  // Never relay `Set-Cookie` or CORS grants onto this origin; `bffOwnsResponseHeader` catches the
  // whole `access-control-*` family.
  'set-cookie',
]);

/**
 * Whether a response header is the BFF's to decide: `access-control-*` by prefix, the rest by name.
 */
function bffOwnsResponseHeader(key: string): boolean {
  return BFF_OWNED.has(key) || key.startsWith('access-control-');
}

/**
 * Client-settable identity and routing headers never forwarded upstream (`X-Forwarded-*`,
 * `Forwarded`, `X-Real-IP`, `X-Original-URL`/`X-Rewrite-URL`, `X-Http-Method-Override`).
 */
const FORWARDING_HEADERS =
  /^(?:x-forwarded-|forwarded$|x-real-ip$|x-original-url$|x-rewrite-url$|x-http-method-override$)/;

const isEventStream = (headers: IncomingHttpHeaders): boolean =>
  String(headers['content-type'] ?? '').includes('text/event-stream');

/**
 * Write SSE comment frames (`: hb`) while the upstream is quiet, so intermediaries do not drop a
 * silent stream. Only at a frame boundary, never mid-frame.
 */
function attachHeartbeat(upstreamRes: IncomingMessage, res: ServerResponse): void {
  let lastChunkAt = Date.now();
  /**
   * The last two bytes forwarded, across chunks, to know whether the stream ended on `\n\n` however
   * it was chunked.
   */
  let tail = '';

  // A 'data' listener coexists with .pipe(); both receive chunks in flowing mode.
  upstreamRes.on('data', (chunk: Buffer) => {
    lastChunkAt = Date.now();
    tail = (tail + chunk.subarray(-2).toString('latin1')).slice(-2);
  });

  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    if (Date.now() - lastChunkAt < cfg.sseHeartbeatMs) return;
    if (tail !== '\n\n') return;
    res.write(': hb\n\n');
  }, cfg.sseHeartbeatMs);

  const stop = (): void => clearInterval(timer);
  res.on('close', stop);
  upstreamRes.on('end', stop);
  upstreamRes.on('error', stop);
}

/**
 * Copy request headers upstream, dropping hop-by-hop and unsafe ones. The correlation id is stamped
 * after the strip loop, so the only `x-chemclaw-*` header upstream sees is the BFF's own.
 */
function buildUpstreamHeaders(
  req: IncomingMessage,
  correlationId: string,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key)) continue;
    if (key === 'accept-encoding') continue;
    // The backend sets allow_credentials=false and uses no cookies at all. Not forwarding them
    // keeps it that way, so there is no CSRF surface to reason about.
    if (key === 'cookie') continue;
    // The service's internal headers: a browser must not set them.
    if (key.startsWith('x-chemclaw-')) continue;
    // Identity and routing headers a browser could use to impersonate the edge; the BFF forwards
    // none.
    if (FORWARDING_HEADERS.test(key)) continue;
    headers[key] = value;
  }
  // Never let the upstream compress an event stream: a compressor buffers until its window
  // fills, so tokens would arrive in clumps or, on a short answer, not until the very end.
  headers['accept-encoding'] = 'identity';
  headers['host'] = upstream.host;
  // Send the correlation id upstream; the service adopts a well-formed one, so one id spans both
  // logs.
  headers[CORRELATION_HEADER] = correlationId;
  return headers;
}

/** The code this process answers a saturated pool with. Not an `errno`; only the log reads it. */
const POOL_TIMEOUT_CODE = 'EPOOLTIMEOUT';

/**
 * Bound the wait for a pooled socket (the agent's queue is otherwise unbounded and untimed). The
 * timer is cleared by the `socket` event. `refuse` writes the answer itself: destroying a request
 * that never got a socket emits no `error` or `close`.
 */
function boundQueueWait(upstreamReq: http.ClientRequest, refuse: () => void): void {
  if (cfg.upstreamQueueTimeoutMs <= 0) return;
  const timer = setTimeout(() => {
    upstreamReq.destroy();
    refuse();
  }, cfg.upstreamQueueTimeoutMs);
  const clear = (): void => clearTimeout(timer);
  upstreamReq.once('socket', clear);
  upstreamReq.once('error', clear);
  upstreamReq.once('close', clear);
}

/**
 * Refuse an oversized body in FastAPI's error shape, logging the route template (never the
 * caller-controlled URL).
 */
function refuseTooLarge(
  trace: RequestTrace,
  req: IncomingMessage,
  res: ServerResponse,
  maxBodyBytes: number,
): void {
  log.warn('refused body over cap', {
    method: req.method,
    route: trace.route,
    max_bytes: maxBodyBytes,
    correlation_id: trace.correlationId,
  });
  if (!res.headersSent) {
    res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ detail: 'request body too large' }));
  }
  req.destroy();
}

export function proxy(
  req: IncomingMessage,
  res: ServerResponse,
  upstreamPath: string,
  expectSse: boolean,
  /** Filled in as the request runs; the access log reads it when the response finishes. */
  trace: RequestTrace,
  maxBodyBytes: number = cfg.maxBodyBytes,
): void {
  const startedAt = Date.now();
  // A declared length over the cap is refused before any upstream request.
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    refuseTooLarge(trace, req, res, maxBodyBytes);
    return;
  }

  const upstreamReq = transport.request(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: upstreamPath,
      headers: buildUpstreamHeaders(req, trace.correlationId),
      // Pool chosen by the route's declaration (the only fact known before the response).
      agent: expectSse ? streamAgent : agent,
    },
    (upstreamRes) => {
      trace.upstreamMs = Date.now() - startedAt;
      // Prefer the service's correlation id when it sent one; `writeHead` overrides the minted
      // header.
      const fromUpstream = correlationFrom(upstreamRes.headers);
      if (fromUpstream) trace.correlationId = fromUpstream;
      const out: http.OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined || HOP_BY_HOP.has(key) || bffOwnsResponseHeader(key)) continue;
        out[key] = value;
      }

      const streaming = expectSse && isEventStream(upstreamRes.headers);
      if (streaming) {
        delete out['content-length'];
        out['cache-control'] = 'no-cache, no-transform';
        // The standard opt-out from nginx's (and several cloud ingresses') response buffering,
        // which would otherwise hold the whole stream until it completes. Harmless elsewhere.
        out['x-accel-buffering'] = 'no';
      }

      res.writeHead(upstreamRes.statusCode ?? 502, out);
      // Without this Node holds the header block until the first body write, so the browser's
      // fetch() promise does not resolve and the client cannot tell "connecting" from "thinking".
      res.flushHeaders();

      if (streaming && cfg.sseHeartbeatMs > 0) attachHeartbeat(upstreamRes, res);

      upstreamRes.pipe(res);
    },
  );

  // No socket idle timeout (see the agents); response headers are bounded separately below.
  upstreamReq.setTimeout(0);

  /** No free socket: answer 503 with `Retry-After` (this process is full), not 502. */
  const refuseSaturated = (): void => {
    if (res.headersSent) return;
    upstreamErrorRecorded();
    log.warn('upstream pool saturated', {
      method: req.method,
      path: upstreamPath,
      code: POOL_TIMEOUT_CODE,
      pool: expectSse ? 'stream' : 'default',
      waited_ms: cfg.upstreamQueueTimeoutMs,
    });
    res.writeHead(503, {
      'content-type': 'application/json',
      connection: 'close',
      'retry-after': '5',
    });
    res.end(
      JSON.stringify({ detail: 'no upstream connection available', code: POOL_TIMEOUT_CODE }),
    );
    // Same reason as the error path below: answering early and then waiting politely for the rest
    // of a body nobody is sending is an unbounded hold.
    if (!req.readableEnded) req.destroy();
  };

  boundQueueWait(upstreamReq, refuseSaturated);

  /**
   * Give up on an upstream that accepted the request but never sent response headers, so a hung
   * backend cannot hold the pool. Bounding headers, not the body, is safe for SSE (a turn's headers
   * arrive immediately).
   */
  const headersTimer =
    cfg.upstreamHeadersTimeoutMs > 0
      ? setTimeout(() => {
          upstreamReq.destroy(new Error('upstream headers timeout'));
        }, cfg.upstreamHeadersTimeoutMs)
      : null;
  const clearHeadersTimer = (): void => {
    if (headersTimer) clearTimeout(headersTimer);
  };
  upstreamReq.on('response', clearHeadersTimer);
  upstreamReq.on('error', clearHeadersTimer);
  upstreamReq.on('close', clearHeadersTimer);

  upstreamReq.on('socket', (socket) => {
    // Token frames are a few bytes each; Nagle would batch them into visible stutter.
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15_000);
    // Bound only the CONNECT phase — an unreachable backend should fail fast even though an
    // established stream may then be silent indefinitely.
    if (cfg.upstreamConnectTimeoutMs > 0 && socket.connecting) {
      const connectTimer = setTimeout(() => {
        upstreamReq.destroy(new Error('upstream connect timeout'));
      }, cfg.upstreamConnectTimeoutMs);
      socket.once('connect', () => clearTimeout(connectTimer));
      upstreamReq.once('error', () => clearTimeout(connectTimer));
    }
  });

  /**
   * Propagate a client disconnect upstream. This detaches rather than cancels (cancelling is `POST
   * /sessions/{id}/turn/stop`), but it stops the service buffering for nobody and frees this
   * process's socket.
   */
  res.on('close', () => {
    if (!res.writableFinished) upstreamReq.destroy();
  });

  upstreamReq.on('error', (err: NodeJS.ErrnoException) => {
    if (res.headersSent) {
      // Unless the response already completed (e.g. our own 413), which destroying would truncate.
      if (!res.writableEnded) res.destroy();
      return;
    }
    upstreamErrorRecorded();
    log.warn('upstream error', {
      method: req.method,
      path: upstreamPath,
      code: err.code ?? 'EPROXY',
      error: err.message,
      // The id this request was sent upstream under.
      correlation_id: trace.correlationId,
    });
    res.writeHead(502, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ detail: 'upstream unavailable', code: err.code ?? 'EPROXY' }));
    // Hang up on a body still arriving after we answered; `requestTimeout` no longer applies then.
    if (!req.readableEnded) req.destroy();
  });

  // Count the body as it passes too: a chunked upload has no `content-length`.
  let received = 0;
  req.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received <= maxBodyBytes) return;
    upstreamReq.destroy();
    refuseTooLarge(trace, req, res, maxBodyBytes);
  });

  req.pipe(upstreamReq);
}
