/**
 * The BFF's request handling and its socket-level limits, as a server nobody has started yet.
 *
 * Split out of `index.ts` so both are testable: `index.ts` is the *entry point* — validate the
 * config, listen, log, shut down — and everything a test would want to drive against real sockets
 * is here. The split is also what made the two defects below expressible as tests rather than as
 * measurements somebody had to take by hand.
 *
 * This process proxies a fixed route list, serves `/config.js`, serves static assets with SPA
 * fallback, answers its own `/healthz`, `/readyz` and `/metrics`, and accepts the browser's log
 * batches on `/api/client-events`. Bare `node:http` rather than a framework — a framework's routing
 * layer would be overhead, and its middleware ecosystem contains at least one thing
 * (`compression`) that silently destroys Server-Sent Events.
 *
 * **Every response is logged and counted**, which it was not: this file handled `/healthz`,
 * `/config.js`, `/api/*` and the static assets and emitted no line on any success path, so an
 * operator watching the UI pod during an incident saw three startup lines and then silence — no
 * request rate, no status distribution, no latency, no per-route volume, no upstream error rate.
 * Both the line and the counters are keyed on the route's PATTERN rather than its path, for the
 * reason `ResolvedRoute.template` gives.
 */

import http from 'node:http';
import { existsSync } from 'node:fs';
import sirv from 'sirv';
import { cfg } from './config.ts';
import { resolveRoute } from './routes.ts';
import { proxy } from './proxy.ts';
import { serveConfigJs } from './runtimeConfig.ts';
import { log } from './log.ts';
import { handleClientEvents } from './clientEvents.ts';
import { readiness } from './ready.ts';
import { renderMetrics, requestFinished, requestStarted } from './metrics.ts';
import type { ProxyTrace } from './proxy.ts';

/**
 * The headers that make this origin safe to be, applied to **every** response.
 *
 * They used to live inside `sirv`'s `setHeaders`, which made them a property of the static file
 * handler rather than of the process: `/api/*`, `/config.js` and `/healthz` all return before
 * `sirv` is ever called, so every one of them was served with no CSP and no nosniff. That matters
 * because the SPA's `script-src 'self'` is what makes the RDKit SVG path unexploitable, and a
 * proxied backend response is a same-origin document — an HTML-typed body on `/api/notes/<id>`
 * was measured executing script on the origin that holds the bearer token.
 */
export function setSecurityHeaders(res: http.ServerResponse): void {
  res.setHeader('content-security-policy', cfg.csp);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  // Both anti-framing controls move together, and on their own switch: tying them to
  // `AUTH_MODE=dev` dropped them for the deployment that requires no sign-in at all.
  if (!cfg.allowFraming) res.setHeader('x-frame-options', 'DENY');
}

/** Static assets, or a handler that makes the "will 404" warning true rather than fatal. */
function createAssetHandler(): (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next?: () => void,
) => void {
  // A missing client directory is survivable and the warning below says so: under `npm run dev`
  // the BFF only proxies and serves /config.js, and Vite serves the client. It was not actually
  // survivable — `sirv` calls `readdirSync` on construction and threw ENOENT one line after the
  // warning promised a 404, so a plain `npm run dev` on a fresh checkout (no `dist/client` yet)
  // killed the BFF at import.
  if (!existsSync(cfg.clientDir)) {
    log.warn(`client directory ${cfg.clientDir} does not exist — static assets will 404.`);
    log.warn('Run `npm run build:client` first, or use `npm run dev` for the Vite dev server.');
    return (_req, res, next) => {
      if (next) return next();
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('client build not present');
    };
  }

  return sirv(cfg.clientDir, {
    // SPA fallback, so /auth/callback and any client route resolve to index.html.
    single: true,
    etag: true,
    // Serve Vite's precompressed output rather than compressing at request time. This is both
    // faster and keeps any compression middleware — which would break SSE — out of the process.
    gzip: true,
    brotli: true,
    setHeaders(res, pathname) {
      // Only caching lives here now: it is the one header that genuinely depends on which file is
      // being served. Hashed assets are immutable; the HTML shell must never be cached, or a deploy
      // won't take AND an authenticated shell can sit in a shared cache for the next visitor.
      //
      // The shell is served for the root, for /index.html, and — via `single` — for any client
      // deep link with no file extension (`/c/abc`). The previous check matched only the first two,
      // so every deep link was served with no cache-control at all. Testing the final segment's
      // extension is testing which file sirv serves: every hashed asset has one and is served
      // directly; an extensionless path falls back to index.html, which is HTML.
      const servesHtmlShell =
        pathname === '/' || pathname === '/index.html' || !/\.[^/]+$/.test(pathname);
      if (servesHtmlShell) {
        res.setHeader('cache-control', 'no-cache');
      }
    },
  });
}

/**
 * Count the bytes this process writes for one response.
 *
 * `res.socket.bytesWritten` is per SOCKET and this server keeps connections alive, so it counts
 * every earlier response on the same connection too. Wrapping the two writers is the only way to
 * attribute bytes to a response — and both wrappers return the original's return value, so
 * backpressure (which `upstreamRes.pipe(res)` depends on) is unchanged.
 */
function countBytes(res: http.ServerResponse): () => number {
  let bytes = 0;
  const add = (chunk: unknown): void => {
    if (typeof chunk === 'string') bytes += Buffer.byteLength(chunk);
    else if (chunk instanceof Uint8Array) bytes += chunk.byteLength;
  };
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  res.write = ((chunk: never, ...rest: never[]) => {
    add(chunk);
    return write(chunk, ...rest);
  }) as typeof res.write;
  res.end = ((chunk?: never, ...rest: never[]) => {
    // `res.end(callback)` is a legal call with no body at all.
    if (typeof chunk !== 'function') add(chunk);
    return end(chunk, ...rest);
  }) as typeof res.end;
  return () => bytes;
}

/**
 * The status booked for a response the client walked away from.
 *
 * nginx's convention, and it is borrowed rather than invented because an abandoned response has no
 * status of its own: `res.statusCode` is whatever was set before the client left — 200 on an SSE
 * stream that had been running for minutes, and a bare `200` default on one where no header was
 * ever written. Booking either would make "how many streams did clients abandon?" unanswerable
 * from the scrape and would count an abandoned turn as a served one.
 */
const CLIENT_CLOSED_REQUEST = 499;

/**
 * One access-log line per response, plus the metrics behind `/metrics`.
 *
 * Written on `close` rather than at dispatch, so the status, the duration and the byte count are
 * the real ones — an SSE turn that ran for nine minutes books nine minutes here, which is the
 * whole point of measuring it. `route` is set by the caller as it dispatches; it starts as the
 * least specific label rather than as the raw path, because a label is a metric dimension and a
 * path is not.
 *
 * **`close`, not `finish`, and the difference was a permanently wrong gauge.** `finish` fires when
 * a response was fully written; a client that hangs up mid-response never reaches it, so neither
 * the access line nor `requestFinished` ran — and `requestStarted` had already run. Measured on
 * the route where it matters most: five aborted `GET /sessions/{id}/events` streams took
 * `chemclaw_ui_requests_in_flight` from 1 to 6 and left it at 6 for the life of the process, so
 * any alert on that gauge fires for ever after the first abandoned stream; and
 * `grep -c 'sessions/{id}/events' bff.log` returned **0** — the longest-lived, most
 * failure-prone route in this process had never written one access line. `close` is emitted on
 * every terminal outcome, completed or aborted, and exactly once, which is what makes the
 * decrement and the line a pair rather than a hope. `proxy.ts` already listened for exactly this
 * to tear the upstream request down (`res.on('close')` there, guarded by the same
 * `writableFinished`), so an abort was being handled correctly everywhere except in what this
 * process says about it.
 */
function observe(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  label: { route: string },
  trace: ProxyTrace,
): void {
  const startedAt = Date.now();
  const bytes = countBytes(res);
  requestStarted();
  res.on('close', () => {
    const durationMs = Date.now() - startedAt;
    // `writableFinished` is the one honest reading of "did this response actually complete?":
    // `res.finished` was deprecated for saying yes as soon as `end()` was *called*.
    const aborted = !res.writableFinished;
    const status = aborted ? CLIENT_CLOSED_REQUEST : res.statusCode;
    requestFinished(label.route, req.method ?? 'GET', status, durationMs / 1000);
    log.info('request', {
      method: req.method ?? 'GET',
      // The PATTERN, never the id-bearing path: see `ResolvedRoute.template`.
      route: label.route,
      status,
      duration_ms: durationMs,
      bytes: bytes(),
      // Kept beside the 499 rather than replacing it: the status is what a query aggregates on,
      // and this is what tells a reader the stream was answering when the client left.
      ...(aborted ? { aborted: true, sent_status: res.statusCode } : {}),
      ...(trace.upstreamMs === null ? {} : { upstream_ms: trace.upstreamMs }),
      // The join key. Present on any request the service answered, which is what makes a line
      // here and a line there the same incident rather than two.
      correlation_id: trace.correlationId,
    });
  });
}

export function createRequestListener(): http.RequestListener {
  const assets = createAssetHandler();

  return (req, res) => {
    setSecurityHeaders(res);

    const rawUrl = req.url ?? '/';
    const path = rawUrl.split('?', 1)[0] ?? '/';
    const method = req.method ?? 'GET';

    const label = { route: 'static' };
    const trace: ProxyTrace = { upstreamMs: null, correlationId: '' };
    observe(req, res, label, trace);

    if (path === '/healthz') {
      // Liveness, and deliberately still a literal: it answers "is this process serving?", which
      // is the only question a restart decision may be made on. Readiness is `/readyz` below.
      label.route = '/healthz';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }

    if (path === '/readyz') {
      label.route = '/readyz';
      void readiness().then((state) => {
        res.writeHead(state.ready ? 200 : 503, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            status: state.ready ? 'ready' : 'degraded',
            upstream_status: state.upstreamStatus,
            ...(state.detail ? { detail: state.detail } : {}),
          }),
        );
      });
      return;
    }

    if (path === '/metrics') {
      // This pod's own numbers, not the service's — `/api/metrics` is deliberately NOT
      // whitelisted and must stay that way. Unauthenticated, like every other `/metrics` in this
      // family, which is why nothing here carries an actor, a session or a path as a label.
      label.route = '/metrics';
      const body = renderMetrics();
      res.writeHead(200, {
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    if (path === '/config.js') {
      label.route = '/config.js';
      serveConfigJs(res);
      return;
    }

    if (path === '/api/client-events') {
      // Answered HERE, never forwarded: the service has no such route, so this pod's log is the
      // sink. It is not in `server/routes.ts` because that list is what gets proxied.
      label.route = '/api/client-events';
      void handleClientEvents(req, res);
      return;
    }

    if (path.startsWith('/api/')) {
      const route = resolveRoute(method, path);
      if (!route) {
        // Not whitelisted: answered here, upstream never contacted. Labelled as one bucket rather
        // than by path — an un-whitelisted path is attacker-chosen, so using it as a metric label
        // would let anyone mint time series in this process.
        label.route = '/api:blocked';
        log.debug('blocked un-whitelisted request', { method, path });
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"detail":"not found"}');
        return;
      }
      label.route = `/api${route.template}`;
      // Preserve the query string — the backend takes none today, but dropping it silently
      // would be a confusing bug the day it does.
      const query = rawUrl.slice(path.length);
      proxy(
        req,
        res,
        route.path + query,
        route.sse,
        route.upload ? cfg.maxUploadBytes : cfg.maxBodyBytes,
        trace,
      );
      return;
    }

    assets(req, res, () => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
    });
  };
}

/** The server, configured but not listening. */
export function createBffServer(): http.Server {
  const server = http.createServer(
    {
      // Node only *checks* `headersTimeout`/`requestTimeout` on a sweep, every
      // `connectionsCheckingInterval` — 30 s by default. A bound that is only enforced up to 30 s
      // late is not the bound it claims to be, so the sweep is derived from the timeout instead of
      // being left at a default that has nothing to do with it.
      connectionsCheckingInterval: Math.max(
        1_000,
        Math.min(30_000, Math.floor(cfg.requestTimeoutMs / 4)),
      ),
      // Time to RECEIVE a request, not to respond, so this bounds nothing about a 600 s turn or a
      // job stream that is silent for minutes — both of those are responses. It was 0 (disabled)
      // on exactly that reasoning, and the reasoning proved to be about the wrong half: 129
      // unauthenticated one-byte POSTs, each holding one upstream socket for ever, took the whole
      // /api surface offline until they were released. See `cfg.requestTimeoutMs`.
      requestTimeout: cfg.requestTimeoutMs,
      // Must exceed any fronting load balancer's idle timeout, or connection reuse races produce
      // sporadic 502s. `headersTimeout` sits just above it for the same reason, and Node refuses
      // to start a server whose `headersTimeout` exceeds its `requestTimeout` — which is why the
      // default of the latter is stated in terms of this pair rather than picked round.
      keepAliveTimeout: 120_000,
      headersTimeout: Math.min(125_000, cfg.requestTimeoutMs),
    },
    createRequestListener(),
  );

  return server;
}
