/**
 * The BFF's request handling and socket limits, as an unstarted server (`index.ts` is the entry
 * point), so tests can drive real sockets.
 *
 * Proxies a fixed route list, serves `/config.js` and static assets with SPA fallback, answers
 * `/healthz`, `/readyz`, `/metrics`, and accepts browser logs on `/api/client-events`. Bare
 * `node:http`: compression middleware breaks SSE. Every response gets one access-log line and
 * metrics, labelled by route pattern.
 */

import http from 'node:http';
import { existsSync } from 'node:fs';
import sirv from 'sirv';
import { cfg, isRdkitWorkerScript, RDKIT_WORKER_CSP } from './config.ts';
import { resolveRoute } from './routes.ts';
import { proxy } from './proxy.ts';
import { serveConfigJs } from './runtimeConfig.ts';
import { log } from './log.ts';
import { handleClientEvents } from './clientEvents.ts';
import { readiness } from './ready.ts';
import { renderMetrics, requestFinished, requestStarted } from './metrics.ts';
import { CORRELATION_HEADER, mintCorrelationId } from './correlation.ts';
import type { RequestTrace } from './proxy.ts';
import { createSandboxHandler } from './sandbox.ts';
import { SANDBOX_FRAME_PATH } from '../shared/sandbox.ts';

/**
 * Security headers for every response, including `/api/*` and `/config.js` (a proxied response is a
 * same-origin document).
 */
export function setSecurityHeaders(res: http.ServerResponse, path = ''): void {
  // The RDKit worker script gets `RDKIT_WORKER_CSP`, keyed on the request path (not `sirv`'s hook,
  // which a 304 bypasses).
  res.setHeader('content-security-policy', isRdkitWorkerScript(path) ? RDKIT_WORKER_CSP : cfg.csp);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  // Both anti-framing controls move together, and on their own switch: tying them to
  // `AUTH_MODE=dev` dropped them for the deployment that requires no sign-in at all.
  if (!cfg.allowFraming) res.setHeader('x-frame-options', 'DENY');
}

/**
 * Whether an asset's URL changes with its bytes (`/assets/<name>-<hash>.<ext>`), and so may be
 * cached immutably. Files from `public/` are not.
 */
function isContentHashed(pathname: string): boolean {
  return /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(pathname);
}

/** Static assets, or a handler that makes the "will 404" warning true rather than fatal. */
function createAssetHandler(): (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next?: () => void,
) => void {
  // Under `npm run dev` there is no client build; skip `sirv` (which throws on a missing directory)
  // and 404 instead.
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
    // Serve the precompressed `.gz`/`.br` siblings `scripts/compress-assets.mjs` writes; no runtime
    // compression (`tests/staticAssets.test.ts`).
    gzip: true,
    brotli: true,
    setHeaders(res, pathname) {
      // The HTML shell (root, `/index.html`, and any extensionless deep link via `single`) must
      // never be cached: a deploy must take effect and an authenticated shell must not sit in a
      // shared cache.
      const servesHtmlShell =
        pathname === '/' || pathname === '/index.html' || !/\.[^/]+$/.test(pathname);
      if (servesHtmlShell) {
        res.setHeader('cache-control', 'no-cache');
        return;
      }
      // Every other asset gets an explicit policy rather than heuristic freshness.
      res.setHeader(
        'cache-control',
        isContentHashed(pathname)
          ? 'public, max-age=31536000, immutable'
          : // Unhashed, so its URL is stable across deploys and its bytes are not: `favicon.svg`
            // and `theme-boot.js` from `public/`. `no-cache` is a revalidation, not a refusal —
            // the ETag turns it into a 304 — and it is what makes changing one of these take.
            'no-cache',
      );
    },
  });
}

/**
 * Count bytes written for one response by wrapping `write`/`end` (socket counters span keep-alive
 * responses). Return values are preserved for backpressure.
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
 * The status booked for a response the client abandoned (nginx's 499), since `res.statusCode` would
 * misreport it.
 */
const CLIENT_CLOSED_REQUEST = 499;

/**
 * One access-log line and the metrics per response, on `close` (not `finish`), which fires exactly
 * once for completed and aborted responses alike — so the in-flight gauge stays correct and long
 * streams are logged with their real duration.
 */
function observe(req: http.IncomingMessage, res: http.ServerResponse, trace: RequestTrace): void {
  const startedAt = Date.now();
  const bytes = countBytes(res);
  requestStarted();
  res.on('close', () => {
    const durationMs = Date.now() - startedAt;
    // `writableFinished` is whether the response actually completed.
    const aborted = !res.writableFinished;
    const status = aborted ? CLIENT_CLOSED_REQUEST : res.statusCode;
    requestFinished(trace.route, req.method ?? 'GET', status, durationMs / 1000);
    log.info('request', {
      method: req.method ?? 'GET',
      // The PATTERN, never the id-bearing path: see `ResolvedRoute.template`.
      route: trace.route,
      status,
      duration_ms: durationMs,
      bytes: bytes(),
      // The 499 is what queries aggregate on; this says what status the stream had been sending.
      ...(aborted ? { aborted: true, sent_status: res.statusCode } : {}),
      ...(trace.upstreamMs === null ? {} : { upstream_ms: trace.upstreamMs }),
      // Correlation id on every line (see `server/correlation.ts`).
      correlation_id: trace.correlationId,
    });
  });
}

/**
 * Handle a rejected request handler: answer 500 if nothing was written, otherwise leave it to the
 * access line. Prevents an `unhandledRejection` (fatal on Node 22) taking down every stream.
 */
function failRequest(
  res: http.ServerResponse,
  trace: RequestTrace,
  stage: string,
  error: unknown,
): void {
  log.error('request handler failed', {
    route: trace.route,
    stage,
    error: error instanceof Error ? error.message : String(error),
    correlation_id: trace.correlationId,
  });
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(500, { 'content-type': 'application/json' });
  res.end('{"detail":"internal error"}');
}

export function createRequestListener(): http.RequestListener {
  const assets = createAssetHandler();

  return (req, res) => {
    const rawUrl = req.url ?? '/';
    const path = rawUrl.split('?', 1)[0] ?? '/';
    setSecurityHeaders(res, path);
    const method = req.method ?? 'GET';

    // One trace per request. The correlation id is minted here, before routing, and set on the
    // response at once; a proxied response may replace it with the service's.
    const trace: RequestTrace = {
      route: 'static',
      upstreamMs: null,
      correlationId: mintCorrelationId(),
    };
    res.setHeader(CORRELATION_HEADER, trace.correlationId);
    observe(req, res, trace);

    if (path === '/healthz') {
      // Liveness, a literal answer: restart decisions must not depend on the backend. Readiness is
      // `/readyz`.
      trace.route = '/healthz';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }

    if (path === '/readyz') {
      trace.route = '/readyz';
      void readiness()
        .then((state) => {
          res.writeHead(state.ready ? 200 : 503, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              status: state.ready ? 'ready' : 'degraded',
              upstream_status: state.upstreamStatus,
              ...(state.detail ? { detail: state.detail } : {}),
            }),
          );
        })
        .catch((error: unknown) => failRequest(res, trace, 'readiness', error));
      return;
    }

    if (path === '/metrics') {
      // This pod's metrics. Unauthenticated, so no actor, session or path labels. `/api/metrics` is
      // never whitelisted.
      trace.route = '/metrics';
      const body = renderMetrics();
      res.writeHead(200, {
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    if (path === '/config.js') {
      trace.route = '/config.js';
      serveConfigJs(res);
      return;
    }

    if (path === '/api/client-events') {
      // Answered HERE, never forwarded: the service has no such route, so this pod's log is the
      // sink. It is not in `server/routes.ts` because that list is what gets proxied.
      trace.route = '/api/client-events';
      void handleClientEvents(req, res).catch((error: unknown) =>
        failRequest(res, trace, 'client-events', error),
      );
      return;
    }

    if (path.startsWith('/api/')) {
      // The query rides along for the one route that holds its id there (`CALC_ARTIFACT_REF`).
      const route = resolveRoute(method, path, rawUrl.slice(path.length));
      if (!route) {
        // Not whitelisted: one bucket label, never the attacker-chosen path.
        trace.route = '/api:blocked';
        log.debug('blocked un-whitelisted request', { method, path });
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"detail":"not found"}');
        return;
      }
      trace.route = `/api${route.template}`;
      // Preserve the query string — the backend takes none today, but dropping it silently
      // would be a confusing bug the day it does.
      const query = rawUrl.slice(path.length);
      proxy(
        req,
        res,
        route.path + query,
        route.sse,
        trace,
        route.upload ? cfg.maxUploadBytes : cfg.maxBodyBytes,
      );
      return;
    }

    if (path === SANDBOX_FRAME_PATH) {
      // Never served on the app origin; answered explicitly because the SPA fallback would
      // otherwise serve something here.
      trace.route = SANDBOX_FRAME_PATH;
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    assets(req, res, () => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
    });
  };
}

/** The header-phase bound applied: clamped to the whole-request bound, as Node requires. */
const headersTimeout = Math.min(cfg.headersTimeoutMs, cfg.requestTimeoutMs);

/** The socket-level options both listeners share — see `createBffServer` for each one's reason. */
function serverOptions(): http.ServerOptions {
  return {
    connectionsCheckingInterval: Math.max(1_000, Math.min(30_000, Math.floor(headersTimeout / 4))),
    requestTimeout: cfg.requestTimeoutMs,
    keepAliveTimeout: 120_000,
    headersTimeout,
  };
}

/**
 * The HTML sandbox listener, started by `index.ts` only when `cfg.sandboxEnabled`. A separate port
 * (a different origin), serving `server/sandbox.ts`'s one page and nothing else, without the app's
 * `frame-ancestors 'none'`. Observed like every other response.
 */
export function createSandboxServer(appOrigin: string = cfg.appOrigin): http.Server {
  const handle = createSandboxHandler(appOrigin);
  const server = http.createServer(serverOptions(), (req, res) => {
    const trace: RequestTrace = {
      route: 'sandbox:other',
      upstreamMs: null,
      correlationId: mintCorrelationId(),
    };
    observe(req, res, trace);
    trace.route = handle(req, res);
  });
  server.maxConnections = cfg.maxConnections;
  return server;
}

/** The server, configured but not listening. */
export function createBffServer(): http.Server {
  const server = http.createServer(
    {
      // Node enforces the request/header timeouts only on a sweep, so derive the sweep interval
      // from the tighter timeout.
      connectionsCheckingInterval: Math.max(
        1_000,
        Math.min(30_000, Math.floor(headersTimeout / 4)),
      ),
      // Time to receive a request (not to respond); see `cfg.requestTimeoutMs`.
      requestTimeout: cfg.requestTimeoutMs,
      // Must exceed any fronting load balancer's idle timeout, or reused connections race into
      // 502s.
      keepAliveTimeout: 120_000,
      headersTimeout,
    },
    createRequestListener(),
  );

  // A connection ceiling this process chooses; see `cfg.maxConnections`.
  server.maxConnections = cfg.maxConnections;

  return server;
}
