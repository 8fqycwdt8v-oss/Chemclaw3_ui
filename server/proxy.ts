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
 *
 * **There are two pools, and that is the load-bearing part.** One `Agent` served both the SSE
 * routes and every ordinary call, which made a *residency* limit and a *burst* limit share one
 * number — and the residents win, because they never leave. Measured on the shipped build with a
 * stub upstream holding streams open: at exactly `maxSockets` live streams an ordinary
 * `GET /api/healthz` never answered (curl exit 28, 0 bytes received), and `POST
 * /sessions/{id}/messages` queued behind the same streams, so the pod was dead for every user for
 * as long as the tabs stayed open. 200 chemists x 3 job streams is 600 against a pool of 512, so
 * that was not a hypothetical: the wall was ~170 users per pod.
 *
 * Split, a saturated stream pool can no longer starve a turn submission, a health probe or a
 * transcript load, whatever the SPA does with its streams.
 */
const agent = new transport.Agent({
  keepAlive: true,
  keepAliveMsecs: 15_000,
  maxSockets: cfg.maxUpstreamSockets,
  timeout: 0,
});

/**
 * The pool for the two long-lived routes — the turn stream and the job push-back stream.
 *
 * Sized by residency rather than by burst: every socket here is held for the life of a turn or of
 * a browser tab, so the number is "how many chemists this pod carries" and nothing else.
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
  return headers;
}

/** The code this process answers a saturated pool with. Not an `errno`; only the log reads it. */
const POOL_TIMEOUT_CODE = 'EPOOLTIMEOUT';

/**
 * Bound the wait for a socket, which is the one phase nothing else here bounds.
 *
 * `agent.timeout`, `request.setTimeout` and `upstreamConnectTimeoutMs` all bound a socket this
 * request already HAS; a request still sitting in `http.Agent`'s queue has none of them, and that
 * queue is unbounded and untimed. So a full pool did not degrade — it stopped, permanently,
 * because the sockets holding it are SSE streams that release only when the tab closes.
 *
 * The timer is armed at request time and cleared by the `socket` event, which the agent emits on
 * dequeue rather than on construction — that ordering is what makes this measure the queue wait
 * and not the connect.
 *
 * **`refuse` writes the answer itself, and that is not a style choice.** The obvious form is
 * `upstreamReq.destroy(err)` and a branch in the `error` handler, which is how this was first
 * written and it hangs: measured on Node 22, destroying a `ClientRequest` that never received a
 * socket emits **no** `error` and **no** `close` — the request is silently dropped and the browser
 * waits for ever, which is the exact defect this bound exists to remove. `destroy()` here is only
 * what unqueues it; a request the agent later hands a socket to sees `destroyed` and releases it.
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
      // The ROUTE's declaration, not the response's content type: the socket is claimed before a
      // single upstream byte is read, so this is the only fact available at the moment the pool is
      // chosen. A stream route that answers 429 or 502 releases its socket immediately anyway.
      agent: expectSse ? streamAgent : agent,
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

  // No idle timeout: see the Agent comment above.
  upstreamReq.setTimeout(0);

  /**
   * Answer a request whose pool never had a socket for it.
   *
   * A pool with nothing free is this process being full, not the backend being down, and the two
   * want opposite things from the caller: 502 says "that request failed", 503 with a `Retry-After`
   * says "come back". The SPA's stream client already backs off with jitter on any non-2xx, so
   * the retry this produces is paced.
   */
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
