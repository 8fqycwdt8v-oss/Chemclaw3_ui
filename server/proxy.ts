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
import { CORRELATION_HEADER, correlationFrom } from './correlation.ts';
import { upstreamErrorRecorded } from './metrics.ts';

/**
 * What one request tells the access log about itself.
 *
 * Passed in and mutated rather than returned, because the facts worth recording are known at
 * different moments — the route as `server/app.ts` dispatches, the upstream duration and the
 * correlation id as the answer comes back — and all of them are known before `res` finishes,
 * which is when the line is written.
 *
 * It covers every request rather than only the proxied ones, which is why it is no longer called
 * `ProxyTrace`: `server/app.ts` used to carry a second `{ route }` object beside it for exactly
 * the same purpose, and the cost of the duplicate was that this file could not name the route it
 * was refusing (see `refuseTooLarge`). It lives here rather than in `app.ts` because `app.ts`
 * already imports this module and the reverse would be a cycle.
 */
export interface RequestTrace {
  /**
   * The route's TEMPLATE, never the path that matched it — see `ResolvedRoute.template`.
   *
   * Starts as the least specific label and is narrowed as dispatch proceeds, so a response that
   * never reaches a route still books one.
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
  // The BFF, not the upstream, decides what may be written on the app origin and who may read a
  // response cross-origin. A relayed `Set-Cookie` is a persistent write on this origin under a
  // service that neither issued nor guards it; a relayed `Access-Control-Allow-Origin: *` (which a
  // misconfigured backend CORS layer can emit) placed on this origin would let any site read
  // authenticated responses. Both are decisions this front door owns and does not delegate — the
  // whole `access-control-*` family is caught by `bffOwnsResponseHeader`, this set names the rest.
  'set-cookie',
]);

/**
 * Whether a response header is the BFF's to decide rather than the upstream's to dictate.
 *
 * The `access-control-*` family is matched by prefix because CORS is several headers
 * (`-allow-origin`, `-allow-credentials`, `-expose-headers`, `-allow-methods`, …) and letting any
 * one through on this origin is the hole; the rest are exact names in `BFF_OWNED`.
 */
function bffOwnsResponseHeader(key: string): boolean {
  return BFF_OWNED.has(key) || key.startsWith('access-control-');
}

/**
 * Client-assertable identity/routing request headers the BFF must not forward upstream.
 *
 * Covers the `X-Forwarded-*` family (`-For`, `-Host`, `-Proto`, `-Port`, …), the bare `Forwarded`
 * header, `X-Real-IP`, the URL-rewrite pair (`X-Original-URL`/`X-Rewrite-URL`) and
 * `X-Http-Method-Override`. Each is browser-settable and each is trusted by some upstream config,
 * so a proxy that relayed them would let a client spoof its own edge address, path or method.
 */
const FORWARDING_HEADERS =
  /^(?:x-forwarded-|forwarded$|x-real-ip$|x-original-url$|x-rewrite-url$|x-http-method-override$)/;

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
  /**
   * The last two bytes forwarded, carried **across** chunks.
   *
   * This used to be a boolean read off one chunk in isolation, and that made the heartbeat latch
   * itself off for the life of a stream. A chunk of a single byte can never satisfy a
   * `tail.length === 2` test, so it set the flag to `false` — and the only thing that could clear
   * it was another chunk, which by definition is not coming, because the stream has just gone
   * quiet. That is precisely the state the heartbeat exists for.
   *
   * Measured through the real proxy with `SSE_HEARTBEAT_MS=300` and the same valid frame delivered
   * two ways: `'data: one\n\n'` as one chunk produced 4 heartbeats; `'data: two\n'` then `'\n'`
   * produced 0, and the stream then sat silent for ever with `x-accel-buffering: no` still set and
   * nothing keeping it alive. Both deliveries are byte-identical on the wire and both are valid
   * SSE — nothing constrains where the backend's `send()` calls or the network put a boundary, and
   * a long `GET /sessions/{id}/events` carries thousands of frames, so hitting one is a matter of
   * time rather than of bad luck. The visible symptom is the job feed dying at random, with the
   * code that prevents it plainly present.
   *
   * Two bytes because that is the whole question — "did the stream end on `\n\n`" — and a rolling
   * tail answers it whatever the chunking. It also removes the length special case: a stream that
   * has forwarded fewer than two bytes is not at a frame boundary, which is the right answer.
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
 * Copy request headers to the upstream, dropping anything hop-by-hop or actively harmful.
 *
 * `correlationId` is this process's own, and is stamped **after** the strip loop for a reason the
 * loop states: an `x-chemclaw-*` header arriving from a browser is dropped, so the only such
 * header the service ever sees on this hop is one the BFF wrote.
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
    // The service's own internal headers, which a browser has no business setting. Nothing on the
    // front door reads them today — the actor comes from the validated bearer token, and these are
    // stamped by the service on its way OUT to a connector — so this is not a live hole; it is the
    // trap removed before somebody adds a reader. A header that arrives from a browser and is
    // named like one the system trusts elsewhere is the shape of the next mistake, not this one.
    if (key.startsWith('x-chemclaw-')) continue;
    // Client-assertable identity/routing headers. A browser can set every one of these, and a
    // backend behind this proxy may trust them: uvicorn honours `X-Forwarded-For`/`Forwarded`
    // under `--proxy-headers`, and `X-Original-URL`/`X-Rewrite-URL`/`X-Http-Method-Override` are
    // classic ways to smuggle a different path or verb past a gateway's own routing/authz. The
    // BFF is the trust boundary; it forges none of these, so it forwards none of them. Same shape
    // as the x-chemclaw- rule above — remove the header that lets a browser impersonate the edge.
    if (FORWARDING_HEADERS.test(key)) continue;
    headers[key] = value;
  }
  // Never let the upstream compress an event stream: a compressor buffers until its window
  // fills, so tokens would arrive in clumps or, on a short answer, not until the very end.
  headers['accept-encoding'] = 'identity';
  headers['host'] = upstream.host;
  // The join key, sent rather than only read back. The service adopts a well-formed inbound id
  // (`_request_correlation_id`, which takes `[A-Za-z0-9_-]{8,64}` and mints its own otherwise), so
  // one id now names this request in this pod's access log, in the service's, and in its
  // `audit_events` — instead of two ids a reader has to line up by timestamp.
  headers[CORRELATION_HEADER] = correlationId;
  return headers;
}

/**
 * Refuse a body this process will not carry, in the shape FastAPI's own errors have.
 *
 * Logged with the route TEMPLATE and not `req.url`, for the reason `server/app.ts` gives about its
 * own metric labels: the path carries a session, note or job id, and this line is written on the
 * one path a caller controls entirely. A `/api:blocked` refusal never reaches here, but an
 * oversized POST to a whitelisted route does, and `path: req.url` put an attacker-chosen string
 * into a log record on an unauthenticated request. The template is a source constant.
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
  // The cheap check first: a declared length over the cap is refused without opening an upstream
  // request at all, which is what stops a 100 MB body from being buffered by the backend before
  // its own validator can reject it.
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
      agent,
    },
    (upstreamRes) => {
      trace.upstreamMs = Date.now() - startedAt;
      // The service's own id wins where it sent one — normally the same string, because it adopts
      // what it was sent. Where it sent none the minted id stands, which is the difference between
      // a 502 that can be looked up and the empty `correlation_id` every failed request used to
      // log. The response header follows the same rule for free: the copy below carries the
      // upstream's value into `writeHead`, which overrides the minted one `server/app.ts` already
      // put on the response with `setHeader`.
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

  // No idle timeout: see the Agent comment above. That is right about the *body* — a job stream is
  // legitimately silent for many minutes — and it left the response *headers* unbounded too, which
  // is a different thing and was the one unrecoverable failure in this file.
  upstreamReq.setTimeout(0);

  /**
   * Give up on an upstream that has accepted the request and never begun answering.
   *
   * `requestTimeoutMs` bounds only how long a client may take to *send*; once a well-formed
   * request had been read, nothing in this process ever gave up. Measured against an upstream that
   * accepts and never answers, with `MAX_UPSTREAM_SOCKETS=4`: four requests claimed the whole
   * agent pool, the next two queued, and after 10 s — five times the configured request timeout —
   * not one of the six had received a single byte. At the shipped pool of 512 that is the entire
   * `/api` surface, `GET /api/healthz` included, offline until the backend answers or every
   * browser gives up. `/readyz` stays 200 throughout, because it probes on `agent: false`, so the
   * pod is never rotated out either. Unlike the slowloris case `serverLimits.test.ts` closed,
   * there was no timeout anywhere that recovered it.
   *
   * Bounding the *headers* rather than the response is what makes one timeout safe on every route,
   * SSE included: a turn's header block arrives immediately and only its body is slow, so this
   * cannot cut a 600 s turn or a quiet job stream. The socket-level `connect` timer above is a
   * narrower thing again — it covers an upstream that never accepts, which is not this.
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
   * Propagate a client disconnect into the upstream request.
   *
   * This used to be the single most important line in the file, and the reason given for it is now
   * wrong: destroying the socket does not cancel anything.
   * `D-2026-08-27-a-disconnect-is-a-detach-not-a-stop` separated the two meanings a closed stream
   * carried, because the backend could not tell Stop from a Wi-Fi handoff and killed ten-minute
   * turns for the latter. A disconnect **detaches** — the turn runs to completion on the
   * service's own pump task and writes its transcript — and cancelling is an explicit
   * `POST /sessions/{id}/turn/stop`, which the SPA sends before it aborts the fetch
   * (`src/state/sendMessage.ts`) and which `server/routes.ts` whitelists.
   *
   * It stays, for what it does do. The service discards events once its reader is gone, so the
   * detach is what stops it buffering for nobody; and leaving a half-read upstream response open
   * holds a socket and a `pipe` in this process for as long as the turn lasts. Neither is the turn
   * lock — a session stays 409-busy now for exactly as long as a turn is genuinely running.
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
      // The id this request was sent upstream under. A 502 is the line somebody comes looking for,
      // and until the front door minted one it was the line guaranteed not to have an id at all.
      correlation_id: trace.correlationId,
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
    refuseTooLarge(trace, req, res, maxBodyBytes);
  });

  req.pipe(upstreamReq);
}
