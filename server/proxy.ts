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
  // Unbounded on purpose. Every SSE stream pins a socket for its whole lifetime — a turn plus up
  // to MAX_JOB_STREAMS job streams per open tab — so a cap here is reached by ordinary use, not by
  // abuse. And the failure it produces is the worst available shape: requests past the cap queue
  // inside the agent without a socket, so `.on('socket')` never fires, the connect timeout never
  // arms, nothing logs, and every /api call simply hangs forever with the process looking healthy.
  // The real bound on concurrency is the backend's own; queueing here only hides it.
  maxSockets: Infinity,
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
  let atFrameBoundary = true;

  // The last two bytes *forwarded*, carried across chunks rather than recomputed from each one.
  // A chunk boundary can fall anywhere, including between the two newlines that terminate a frame
  // and inside a 1-byte chunk, so `chunk.subarray(-2)` cannot see a terminator that straddles two
  // chunks: it reported mid-frame and suppressed the heartbeat for the whole idle that followed,
  // which is precisely when the heartbeat exists to fire.
  let prev = 0;
  let last = 0;

  // A 'data' listener coexists with .pipe(); both receive chunks in flowing mode.
  upstreamRes.on('data', (chunk: Buffer) => {
    lastChunkAt = Date.now();
    if (chunk.length >= 2) {
      prev = chunk[chunk.length - 2]!;
      last = chunk[chunk.length - 1]!;
    } else if (chunk.length === 1) {
      prev = last;
      last = chunk[0]!;
    }
    atFrameBoundary = prev === 0x0a && last === 0x0a;
  });

  // Tick at half the threshold. With one value used as both, a gap that opened just after a tick
  // was not noticed until the next one, so the worst-case wire silence was 2x SSE_HEARTBEAT_MS —
  // the knob did not bound what its name says it bounds, which matters when it is being set to sit
  // under a specific intermediary's idle timeout.
  const timer = setInterval(
    () => {
      if (res.writableEnded || res.destroyed) return;
      if (Date.now() - lastChunkAt < cfg.sseHeartbeatMs) return;
      if (!atFrameBoundary) return;
      res.write(': hb\n\n');
    },
    Math.max(1, Math.floor(cfg.sseHeartbeatMs / 2)),
  );

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
    headers[key] = value;
  }
  // Never let the upstream compress an event stream: a compressor buffers until its window
  // fills, so tokens would arrive in clumps or, on a short answer, not until the very end.
  headers['accept-encoding'] = 'identity';
  headers['host'] = upstream.host;
  return headers;
}

export function proxy(
  req: IncomingMessage,
  res: ServerResponse,
  upstreamPath: string,
  expectSse: boolean,
): void {
  /**
   * Set when the client goes away first — Stop, a closed tab, a navigation.
   *
   * That path tears the upstream request down deliberately (see the `res.on('close')` handler
   * below), and the upstream response then emits ECONNRESET on the way out. Without this flag the
   * error handler reports every Stop as an upstream failure, which is both untrue and the sort of
   * log noise that sends someone looking for a backend problem that never happened.
   */
  let clientGone = false;

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

      /**
       * An upstream that dies *after* its headers is the case `upstreamReq.on('error')` below does
       * not cover: once the response callback has run, a broken connection surfaces here, on the
       * response, not on the request. And `.pipe()` does not forward a source error to its
       * destination — it only unpipes. So without this the client response was never ended and
       * never destroyed: the browser held an open, silent connection indefinitely, with no error
       * event and nothing in the log. A turn stream simply stopped mid-sentence.
       *
       * Headers are already sent, so there is no status left to write. Destroying is what tells
       * the client the response is not coming; `streamTurn` surfaces that as a stream error.
       */
      upstreamRes.on('error', (err: NodeJS.ErrnoException) => {
        // Our own teardown coming back at us. Nothing to report and nothing left to close.
        if (clientGone) return;
        log.warn(
          `upstream stream error for ${req.method} ${upstreamPath}: ${err.message} (${err.code ?? 'no code'})`,
        );
        if (!res.writableEnded) res.destroy();
      });

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
    if (!res.writableFinished) {
      clientGone = true;
      upstreamReq.destroy();
    }
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

  // Request bodies are small — the backend caps messages at 100k chars — except attachments,
  // which stream through just as happily.
  req.pipe(upstreamReq);
}
