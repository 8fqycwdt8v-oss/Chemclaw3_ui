/**
 * The BFF: static host for the SPA plus a whitelisted streaming proxy to the Chemclaw service.
 *
 * Bare `node:http` rather than a framework. This process does four things — proxy a fixed route
 * list, serve `/config.js`, serve static assets with SPA fallback, and answer its own `/healthz`.
 * A framework's routing layer would be overhead, and its middleware ecosystem contains at least
 * one thing (`compression`) that silently destroys Server-Sent Events.
 */

import http from 'node:http';
import { existsSync } from 'node:fs';
import sirv from 'sirv';
import { cfg, isLoopbackHost, validateConfig } from './config.ts';
import { resolveRoute } from './routes.ts';
import { proxy } from './proxy.ts';
import { serveConfigJs } from './runtimeConfig.ts';
import { currentSession, handleAuthRoute } from './auth/handlers.ts';
import { checkCsrf } from './auth/csrf.ts';
import { log } from './log.ts';

const problems = validateConfig();
if (problems.length > 0) {
  for (const problem of problems) log.error(`config: ${problem}`);
  process.exit(1);
}

if (!existsSync(cfg.clientDir)) {
  log.warn(`client directory ${cfg.clientDir} does not exist — static assets will 404.`);
  log.warn('Run `npm run build:client` first, or use `npm run dev` for the Vite dev server.');
}

const assets = sirv(cfg.clientDir, {
  // SPA fallback, so /auth/callback and any client route resolve to index.html.
  single: true,
  etag: true,
  // Serve precompressed siblings when they exist, rather than compressing at request time —
  // request-time compression would mean a compression middleware in this process, and the one
  // everybody reaches for silently destroys Server-Sent Events.
  //
  // These are now actually produced: the comment used to claim it was serving "Vite's
  // precompressed output", but nothing in the build generated a single `.gz` or `.br`, so both
  // flags were inert and every asset shipped uncompressed. `scripts/compress-client.mjs` fills
  // that in as a build step.
  gzip: true,
  brotli: true,
  setHeaders(res, pathname) {
    setSecurityHeaders(res);
    // Hashed assets are immutable; HTML must never be cached or a deploy won't take.
    //
    // The test used to be `pathname === '/index.html' || pathname === '/'`, and sirv passes the
    // REQUESTED pathname rather than the resolved file — so every SPA-fallback route (`/chat/…`,
    // `/auth/callback`) served index.html with no `Cache-Control` at all and picked up heuristic
    // freshness from `Last-Modified`. That is exactly the stale-bundle-after-deploy failure this
    // header exists to prevent. Anything without a file extension resolves to index.html under
    // `single: true`, so that is the condition to test.
    if (isHtmlRequest(pathname)) res.setHeader('cache-control', 'no-cache');
  },
});

/** Paths sirv's `single: true` fallback answers with index.html: no extension, or index.html itself. */
function isHtmlRequest(pathname: string): boolean {
  if (pathname === '/' || pathname === '/index.html') return true;
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return !last.includes('.');
}

/**
 * The browser security headers, applied to EVERY response this process writes.
 *
 * Previously only sirv-served responses got them, so `/healthz`, `/config.js`, both 404 bodies and
 * every proxied `/api/*` response carried no CSP, no `nosniff` and no framing protection.
 *
 * `X-Frame-Options` is no longer dropped in dev mode. It was omitted so the Replit preview iframe
 * could load the page — but `buildCsp` already handles that with `frame-ancestors *`, which is the
 * modern directive and the one browsers prefer when both are present. Omitting the legacy header
 * as well bought nothing and left dev deployments clickjackable in older browsers that ignore
 * `frame-ancestors`. `SAMEORIGIN` keeps the preview working where `frame-ancestors` is honoured
 * while still refusing a cross-origin frame everywhere else.
 */
function setSecurityHeaders(res: http.ServerResponse): void {
  res.setHeader('content-security-policy', cfg.csp);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('x-frame-options', cfg.authMode === 'dev' ? 'SAMEORIGIN' : 'DENY');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
}

/**
 * The last resort for an async handler that rejected.
 *
 * Without this, a rejected promise off `http.createServer`'s synchronous callback becomes an
 * unhandled rejection — which under Node's default `--unhandled-rejections=throw` takes the whole
 * process down and hangs every open SSE stream with it. One bad request must not do that.
 */
function failRequest(res: http.ServerResponse, what: string, err: unknown): void {
  log.error(`unhandled error in ${what}: ${err instanceof Error ? err.stack : String(err)}`);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(500, { 'content-type': 'application/json' });
  res.end('{"detail":"internal error"}');
}

function methodNotAllowed(res: http.ServerResponse, allow: string): void {
  res.writeHead(405, { 'content-type': 'application/json', allow });
  res.end('{"detail":"method not allowed"}');
}

export { setSecurityHeaders };

/**
 * Everything a request needs before it can be proxied, which in `bff` mode means the session.
 *
 * Split out because it is the one asynchronous step in an otherwise synchronous dispatcher: the
 * session may need refreshing at the identity provider before the request can carry a token.
 */
async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  path: string,
  query: string,
): Promise<void> {
  const route = resolveRoute(method, path);
  if (!route) {
    // Not whitelisted: answered here, upstream never contacted.
    log.debug(`blocked un-whitelisted ${method} ${path}`);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"detail":"not found"}');
    return;
  }

  if (cfg.authMode !== 'bff') {
    // `msal-spa` and `dev`: no cookies on this origin, so no CSRF surface, and the browser's own
    // Authorization header (or its absence) is forwarded verbatim as it always was.
    proxy(req, res, route.path + query, route.sse);
    return;
  }

  const session = await currentSession(req, res);
  const verdict = checkCsrf(req, session);
  if (!verdict.ok) {
    log.warn(`refused ${method} ${path}: ${verdict.reason}`);
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end('{"detail":"This request could not be verified."}');
    return;
  }
  // Non-null even when there is no session: it is what tells the proxy to discard whatever
  // `Authorization` the browser sent, which under BFF custody is by definition not ours.
  proxy(req, res, route.path + query, route.sse, { accessToken: session?.accessToken ?? '' });
}

const server = http.createServer((req, res) => {
  const rawUrl = req.url ?? '/';
  const path = rawUrl.split('?', 1)[0] ?? '/';
  const method = req.method ?? 'GET';

  setSecurityHeaders(res);

  // GET/HEAD only on the two locally-answered endpoints. They dispatched on path alone, so
  // `DELETE /healthz` returned 200 and `PUT /config.js` served the config script.
  const isRead = method === 'GET' || method === 'HEAD';

  if (path === '/healthz') {
    if (!isRead) return methodNotAllowed(res, 'GET, HEAD');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(method === 'HEAD' ? undefined : '{"status":"ok"}');
    return;
  }

  if (path === '/config.js') {
    if (!isRead) return methodNotAllowed(res, 'GET, HEAD');
    serveConfigJs(res);
    return;
  }

  // In `bff` mode these are answered here. In the other two they fall through to the SPA, so
  // browser-MSAL's `/auth/callback` still resolves to index.html exactly as before.
  if (path.startsWith('/auth/')) {
    handleAuthRoute(req, res, path, rawUrl)
      .then((handled) => {
        if (handled) return;
        assets(req, res, () => {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('Not Found');
        });
      })
      .catch((err: unknown) => failRequest(res, `auth ${method} ${path}`, err));
    return;
  }

  if (path.startsWith('/api/')) {
    // Preserve the query string — the backend takes none today, but dropping it silently
    // would be a confusing bug the day it does.
    const query = rawUrl.slice(path.length);
    handleApi(req, res, method, path, query).catch((err: unknown) =>
      failRequest(res, `${method} ${path}`, err),
    );
    return;
  }

  assets(req, res, () => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
  });
});

// Must exceed any fronting load balancer's idle timeout, or connection reuse races produce
// sporadic 502s. `requestTimeout` measures time to RECEIVE a request, not to respond, so
// disabling it does not affect long SSE responses — but set it explicitly so nobody has to
// re-derive that when they see a 600s stream and a 300s default in the Node docs.
server.keepAliveTimeout = 120_000;
server.headersTimeout = 125_000;
server.requestTimeout = 0;

server.listen(cfg.port, cfg.bindHost, () => {
  log.info(`chemclaw3-ui listening on http://${cfg.bindHost}:${cfg.port}`);
  log.info(`proxying /api -> ${cfg.apiUrl}`);
  log.info(`auth mode: ${cfg.authMode}`);

  // The refusal itself now lives in `validateConfig` and has already run above, so reaching here
  // in this combination means someone set ALLOW_INSECURE_AUTH deliberately. Say so anyway — the
  // backend keeps the same warning on the same opt-out, for the same reason: an accepted risk
  // should still be visible in the log of the thing that accepted it.
  if (cfg.authMode === 'bff' && !cfg.publicOrigin) {
    log.warn(
      'PUBLIC_ORIGIN is not set, so the OAuth redirect URI and the CSRF origin check are both ' +
        'derived from the client-supplied Host header. Both have an independent check behind ' +
        'them, but a mismatch presents as an unexplained AADSTS50011 — set PUBLIC_ORIGIN to this ' +
        "deployment's browser-facing origin.",
    );
  }

  if (cfg.authMode === 'dev' && !isLoopbackHost(cfg.bindHost)) {
    log.warn(
      `SECURITY: AUTH_MODE=dev on a non-loopback bind (${cfg.bindHost}) with ` +
        'ALLOW_INSECURE_AUTH=true. No sign-in is required, so every visitor drives the agent as ' +
        'a shared principal with all authorization gates open. Do not expose this beyond a ' +
        'trusted dev network.',
    );
  }
});

const shutdown = (signal: string) => () => {
  log.info(`${signal} received, closing`);
  server.close(() => process.exit(0));
  // Open SSE streams hold the server open indefinitely; don't wait forever on them.
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on('SIGTERM', shutdown('SIGTERM'));
process.on('SIGINT', shutdown('SIGINT'));
