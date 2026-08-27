/**
 * The streaming reverse proxy to the Chemclaw service.
 *
 * Built on `node:http.request` rather than `fetch`/undici deliberately. Node's global fetch
 * dispatcher defaults to `bodyTimeout: 300_000` — an *idle* timeout between body chunks — and
 * `GET /sessions/{id}/events` is legitimately silent for many minutes at a time, so undici would
 * abort a perfectly healthy stream after five. A 600s turn on the messages endpoint sits right on
 * the same edge. `http.request` has no body idle timeout, hands back a `Readable` on both sides so
 * `.pipe()` gives us backpressure for free, and needs no dependency.
 *
 * Authorization headers are forwarded verbatim and never inspected. The backend already performs
 * full RS256 signature + audience + issuer validation on every request; a second copy of that
 * logic here would be one more thing to misconfigure and would make the origin of a 401 ambiguous.
 */

import http from 'node:http';
import https from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { cfg } from './config.ts';
import { log } from './log.ts';
import { upstreamErrorRecorded } from './metrics.ts';

/**
 * What one proxied request tells the access log about itself.
 *
 * Passed in and mutated rather than returned, because the two facts worth recording — how long the
 * upstream took and the correlation id it answered with — are known at different moments, and both
 * are known before `res` finishes, which is when the line is written.
 */
export interface ProxyTrace {
  /** Milliseconds from opening the upstream request to its response headers. Null if none came. */
  upstreamMs: number | null;
  /** The service's own id for this request, read back from its response header. */
  correlationId: string;
}

/**
 * The response header the Chemclaw service stamps its per-request correlation id on.
 *
 * Read here and forwarded to the browser by the header copy below (it is neither hop-by-hop nor
 * BFF-owned, so it already crosses) — and written into this process's access log, which is what
 * lets one line here be joined to the service's own record of the same request.
 */
const CORRELATION_HEADER = 'x-chemclaw-correlation-id';

const upstream = new URL(cfg.apiUrl);
const transport = upstream.protocol === 'https:' ? https : http;

/**
 * keepAlive with NO socket timeout. A turn can legitimately run for the backend's full 600s
 * wall clock without producing a byte, and the job stream longer still.
 *
 * The pool size is a security control as much as a capacity one: a request claims a socket the
 * moment its first body byte arrives, so anything that can open connections and dribble bytes can
 * hold the pool. `cfg.requestTimeoutMs` is what puts a bound on that; this is the ceiling it is
 * bounding, and it is configurable so the two can be tuned together.
 */
const agent = new transport.Agent({
  keepAlive: true,
  keepAliveMsecs: 15_000,
  maxSockets: cfg.maxUpstreamSockets,
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
 * Response headers this process owns, whatever the upstream says.
 *
 * A proxied response is delivered on the app's own origin, so its CSP and nosniff are the SPA's
 * to state. Letting the backend's copy through would mean the security posture of a same-origin
 * document was decided by whichever service answered it.
 */
const BFF_OWNED = new Set([
  'content-security-policy',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
]);

const isEventStream = (headers: IncomingHttpHeaders): boolean =>
  String(headers['content-type'] ?? '').includes('text/event-stream');

/**
 * Inject SSE comment frames while the upstream is quiet, so intermediaries with idle timeouts
 * do not drop a healthy but silent stream.
 *
 * Only ever writes `: hb\n\n` — a comment, which every SSE parser discards. It never synthesises
 * a fake event. It also only writes at a frame boundary: if the last bytes we forwarded were not
 * `\n\n`, we may be mid-frame (a frame can be split across TCP chunks), and injecting there would
 * corrupt the frame the client is still assembling.
 */
function attachHeartbeat(upstreamRes: IncomingMessage, res: ServerResponse): void {
  let lastChunkAt = Date.now();
  let atFrameBoundary = true;

  // A 'data' listener coexists with .pipe(); both receive chunks in flowing mode.
  upstreamRes.on('data', (chunk: Buffer) => {
    lastChunkAt = Date.now();
    const tail = chunk.subarray(-2);
    atFrameBoundary = tail.length === 2 && tail[0] === 0x0a && tail[1] === 0x0a;
  });

  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    if (Date.now() - lastChunkAt < cfg.sseHeartbeatMs) return;
    if (!atFrameBoundary) return;
    res.write(': hb\n\n');
  }, cfg.sseHeartbeatMs);

  const stop = (): void => clearInterval(timer);
  res.on('close', stop);
  upstreamRes.on('end', stop);
  upstreamRes.on('error', stop);
}

/** Copy request headers to the upstream, dropping anything hop-by-hop or actively harmful. */
function buildUpstreamHeaders(req: IncomingMessage): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key)) continue;
    if (key === 'accept-encoding') continue;
    // The backend sets allow_credentials=false and uses no cookies at all. Not forwarding them
    // keeps it that way, so there is no CSRF surface to reason about.
    if (key === 'cookie') continue;
    // The service's own internal headers, which a browser has no business setting. Nothing on the
    // front door reads them today — the actor comes from the validated bearer token, and these are
    // stamped by the service on its way OUT to a connector — so this is not a live hole; it is the
    // trap removed before somebody adds a reader. A header that arrives from a browser and is
    // named like one the system trusts elsewhere is the shape of the next mistake, not this one.
    if (key.startsWith('x-chemclaw-')) continue;
    headers[key] = value;
  }
  // Never let the upstream compress an event stream: a compressor buffers until its window
  // fills, so tokens would arrive in clumps or, on a short answer, not until the very end.
  headers['accept-encoding'] = 'identity';
  headers['host'] = upstream.host;
  return headers;
}

/** Refuse a body this process will not carry, in the shape FastAPI's own errors have. */
function refuseTooLarge(req: IncomingMessage, res: ServerResponse, maxBodyBytes: number): void {
  log.warn('refused body over cap', {
    method: req.method,
    path: req.url,
    max_bytes: maxBodyBytes,
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
  maxBodyBytes: number = cfg.maxBodyBytes,
  /** Filled in as the request runs; the access log reads it when the response finishes. */
  trace?: ProxyTrace,
): void {
  const startedAt = Date.now();
  // The cheap check first: a declared length over the cap is refused without opening an upstream
  // request at all, which is what stops a 100 MB body from being buffered by the backend before
  // its own validator can reject it.
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    refuseTooLarge(req, res, maxBodyBytes);
    return;
  }

  const upstreamReq = transport.request(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: upstreamPath,
      headers: buildUpstreamHeaders(req),
      agent,
    },
    (upstreamRes) => {
      if (trace) {
        trace.upstreamMs = Date.now() - startedAt;
        const correlation = upstreamRes.headers[CORRELATION_HEADER];
        trace.correlationId = Array.isArray(correlation)
          ? (correlation[0] ?? '')
          : (correlation ?? '');
      }
      const out: http.OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined || HOP_BY_HOP.has(key) || BFF_OWNED.has(key)) continue;
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

  // No idle timeout: see the Agent comment above.
  upstreamReq.setTimeout(0);

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
   * Propagate a client disconnect into the upstream request.
   *
   * This is the single most important line in the file. The backend serialises turns per session
   * and there is no cancel endpoint: if the user presses Stop (or closes the tab) and we leave the
   * upstream request open, the turn keeps running, keeps spending budget, and keeps holding the
   * session's turn slot — so the next message comes back 409 "a turn is already running". FastAPI
   * cancels the handler on client disconnect, so destroying the socket here is what actually
   * releases that lock.
   */
  res.on('close', () => {
    if (!res.writableFinished) upstreamReq.destroy();
  });

  upstreamReq.on('error', (err: NodeJS.ErrnoException) => {
    if (res.headersSent) {
      // Unless the response is already complete — a body we refused ourselves has its 413 in the
      // socket buffer, and destroying here would truncate the very answer that explains the
      // refusal, leaving the caller with a bare connection reset.
      if (!res.writableEnded) res.destroy();
      return;
    }
    upstreamErrorRecorded();
    log.warn('upstream error', {
      method: req.method,
      path: upstreamPath,
      code: err.code ?? 'EPROXY',
      error: err.message,
    });
    res.writeHead(502, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ detail: 'upstream unavailable', code: err.code ?? 'EPROXY' }));
    // And hang up on a body still arriving. Node stops enforcing `requestTimeout` once the
    // response has completed, so answering early and then waiting politely for the rest of a
    // request nobody is sending is precisely the unbounded hold the timeout exists to prevent.
    if (!req.readableEnded) req.destroy();
  });

  // And the same cap counted as it passes, because `content-length` is absent on a chunked
  // upload — a body with no declared length is exactly the one the check above cannot see.
  // A 'data' listener coexists with .pipe(); both receive chunks in flowing mode.
  let received = 0;
  req.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received <= maxBodyBytes) return;
    upstreamReq.destroy();
    refuseTooLarge(req, res, maxBodyBytes);
  });

  req.pipe(upstreamReq);
}
