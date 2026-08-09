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

const upstream = new URL(cfg.apiUrl);
const transport = upstream.protocol === 'https:' ? https : http;

/**
 * keepAlive with NO socket timeout. A turn can legitimately run for the backend's full 600s
 * wall clock without producing a byte, and the job stream longer still.
 */
const agent = new transport.Agent({
  keepAlive: true,
  keepAliveMsecs: 15_000,
  maxSockets: 128,
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
  // The last two bytes forwarded, tracked ACROSS chunks rather than within one.
  //
  // This was `chunk.subarray(-2)` per chunk, which is wrong for the case that matters: a frame
  // terminator split across TCP chunks arrives as a final chunk of a single `\n`, giving
  // `tail.length === 1` and therefore `atFrameBoundary = false`. Nothing reset it until the next
  // `data` event — so if the stream then went quiet, which is precisely the situation heartbeats
  // exist for, the heartbeat never fired again and an idle-timeout intermediary was free to drop
  // a perfectly healthy stream. Carrying the previous byte forward makes the boundary test a
  // property of the byte stream instead of a property of how it happened to be chunked.
  let prevByte = -1;
  let lastByte = -1;

  // A 'data' listener coexists with .pipe(); both receive chunks in flowing mode.
  upstreamRes.on('data', (chunk: Buffer) => {
    lastChunkAt = Date.now();
    if (chunk.length === 0) return;
    if (chunk.length === 1) {
      prevByte = lastByte;
      lastByte = chunk[0] ?? -1;
    } else {
      prevByte = chunk[chunk.length - 2] ?? -1;
      lastByte = chunk[chunk.length - 1] ?? -1;
    }
  });

  const atFrameBoundary = (): boolean => prevByte === 0x0a && lastByte === 0x0a;

  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    if (Date.now() - lastChunkAt < cfg.sseHeartbeatMs) return;
    // Before any body byte has been forwarded we are trivially at a boundary — there is no
    // half-written frame to corrupt — so a stream that is silent from the very first moment
    // (a turn waiting on an admission permit) still gets its keepalive.
    if (lastByte !== -1 && !atFrameBoundary()) return;
    res.write(': hb\n\n');
  }, cfg.sseHeartbeatMs);

  const stop = (): void => clearInterval(timer);
  res.on('close', stop);
  upstreamRes.on('end', stop);
  upstreamRes.on('error', stop);
}

/**
 * Request headers the upstream is allowed to see.
 *
 * An **allow-list**, and it used to be a deny-list. The difference matters because the deny-list
 * only named what it had thought of: `x-forwarded-for`, `x-forwarded-host`, `x-forwarded-proto`,
 * `x-real-ip` and any header a caller cared to invent all reached the backend verbatim, and this
 * process set none of them itself. Nothing upstream trusts them *today*, but "no component
 * between the browser and the service ever starts trusting a forwarded header" is not a property
 * a proxy can assume on the service's behalf — and if one ever does, a spoofed client IP is a
 * rate-limit bypass and an audit-trail lie.
 *
 * The set is small because the backend's surface is small: a bearer token, content negotiation,
 * and the bits `multipart/form-data` needs.
 */
const FORWARDED_REQUEST_HEADERS = new Set([
  'authorization',
  'accept',
  'accept-language',
  'content-type',
  'content-length',
  'user-agent',
  'if-none-match',
  'if-modified-since',
  'last-event-id',
]);

/**
 * Response headers the browser is allowed to see.
 *
 * Also an allow-list, for the mirror-image reason. The old code copied everything non-hop-by-hop,
 * which forwarded `set-cookie` from the backend onto this app's origin — while the request leg
 * stripped `cookie`, so the cookie could be set and would then never come back. That asymmetry
 * quietly contradicted the invariant the request leg asserts ("no cookies at all, so there is no
 * CSRF surface to reason about"). It also relayed `server:`/`x-powered-by` banners.
 */
const FORWARDED_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'cache-control',
  'etag',
  'last-modified',
  'retry-after',
  'content-disposition',
  'vary',
]);

/** Copy the allowed request headers to the upstream and set the ones we own authoritatively. */
function buildUpstreamHeaders(req: IncomingMessage): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key)) continue;
    if (!FORWARDED_REQUEST_HEADERS.has(key)) continue;
    headers[key] = value;
  }
  // Never let the upstream compress an event stream: a compressor buffers until its window
  // fills, so tokens would arrive in clumps or, on a short answer, not until the very end.
  headers['accept-encoding'] = 'identity';
  headers['host'] = upstream.host;
  // Set by us, not copied: a client-supplied value here would be a forgery, and an absent value
  // is worse than a wrong one for anything downstream that logs it.
  const remote = req.socket.remoteAddress;
  if (remote) headers['x-forwarded-for'] = remote;
  headers['x-forwarded-proto'] = upstream.protocol === 'https:' ? 'https' : 'http';
  return headers;
}

export function proxy(
  req: IncomingMessage,
  res: ServerResponse,
  upstreamPath: string,
  expectSse: boolean,
): void {
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
      const out: http.OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined || HOP_BY_HOP.has(key)) continue;
        if (!FORWARDED_RESPONSE_HEADERS.has(key)) continue;
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
      res.destroy();
      return;
    }
    log.warn(`upstream error for ${req.method} ${upstreamPath}: ${err.message}`);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: 'upstream unavailable', code: err.code ?? 'EPROXY' }));
  });

  // Bound the request body.
  //
  // This used to be a bare `req.pipe(upstreamReq)` with a comment observing that attachments
  // "stream through just as happily" — which is exactly the problem: nothing capped them, and
  // `server.requestTimeout` was 0, so one client could stream unlimited bytes for unlimited time
  // through this process and into the backend. The backend caps bodies at 4 MB and answers 413;
  // refusing at the edge means the bytes never cross the internal network, and the caller gets
  // the same status either way.
  let received = 0;
  let refused = false;
  req.on('data', (chunk: Buffer) => {
    if (refused) return;
    received += chunk.length;
    if (received <= cfg.maxBodyBytes) return;
    refused = true;
    log.warn(`request body over ${cfg.maxBodyBytes} bytes for ${req.method} ${upstreamPath}`);
    upstreamReq.destroy();
    if (!res.headersSent) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: `request body exceeds the ${cfg.maxBodyBytes} byte limit` }));
    }
    req.destroy();
  });

  req.pipe(upstreamReq);
}
