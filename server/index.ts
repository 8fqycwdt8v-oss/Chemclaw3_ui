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
  // Serve Vite's precompressed output rather than compressing at request time. This is both
  // faster and keeps any compression middleware — which would break SSE — out of the process.
  gzip: true,
  brotli: true,
  setHeaders(res, pathname) {
    res.setHeader('content-security-policy', cfg.csp);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    // Omit X-Frame-Options in dev mode so the Replit preview iframe can load the page.
    // Production (msal auth) keeps the strict DENY.
    if (cfg.authMode !== 'dev') res.setHeader('x-frame-options', 'DENY');
    // Hashed assets are immutable; index.html must never be cached or a deploy won't take.
    if (pathname === '/index.html' || pathname === '/') {
      res.setHeader('cache-control', 'no-cache');
    }
  },
});

const server = http.createServer((req, res) => {
  const rawUrl = req.url ?? '/';
  const path = rawUrl.split('?', 1)[0] ?? '/';
  const method = req.method ?? 'GET';

  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"ok"}');
    return;
  }

  if (path === '/config.js') {
    serveConfigJs(res);
    return;
  }

  if (path.startsWith('/api/')) {
    const route = resolveRoute(method, path);
    if (!route) {
      // Not whitelisted: answered here, upstream never contacted.
      log.debug(`blocked un-whitelisted ${method} ${path}`);
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"detail":"not found"}');
      return;
    }
    // Preserve the query string — the backend takes none today, but dropping it silently
    // would be a confusing bug the day it does.
    const query = rawUrl.slice(path.length);
    proxy(req, res, route.path + query, route.sse);
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

  if (cfg.authMode === 'dev' && !isLoopbackHost(cfg.bindHost)) {
    // Reaching this line now means ALLOW_INSECURE_AUTH=true — `validateConfig` refuses to start
    // otherwise. So this is no longer the guard; it is the receipt for a deliberate choice, and it
    // names the flag so the next reader of these logs knows the exposure was configured rather
    // than stumbled into.
    log.warn(
      `SECURITY: AUTH_MODE=dev on a non-loopback bind (${cfg.bindHost}) with ` +
        'ALLOW_INSECURE_AUTH=true. No sign-in is required and the backend is almost certainly ' +
        'running with CHEMCLAW_ENTRA_REQUIRED=false, meaning every request is a shared principal ' +
        'with all authorization gates open. Do not expose this beyond a trusted dev network.',
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
