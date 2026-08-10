/**
 * The BFF: static host for the SPA plus a whitelisted streaming proxy to the Chemclaw service.
 *
 * Bare `node:http` rather than a framework. This process does four things — proxy a fixed route
 * list, serve `/config.js`, serve static assets with SPA fallback, and answer its own `/healthz`.
 * A framework's routing layer would be overhead, and its middleware ecosystem contains at least
 * one thing (`compression`) that silently destroys Server-Sent Events.
 */

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import sirv from 'sirv';
import { cfg, validateConfig } from './config.ts';
import { resolveRoute } from './routes.ts';
import { proxy } from './proxy.ts';
import { serveConfigJs } from './runtimeConfig.ts';
import { log } from './log.ts';

const problems = validateConfig();
if (problems.length > 0) {
  for (const problem of problems) log.error(`config: ${problem}`);
  process.exit(1);
}

const clientDirExists = existsSync(cfg.clientDir);
if (!clientDirExists) {
  log.warn(`client directory ${cfg.clientDir} does not exist — static assets will 404.`);
  log.warn('Run `npm run build:client` first, or use `npm run dev` for the Vite dev server.');
}

/**
 * Built only when the directory is there.
 *
 * `sirv` reads the tree eagerly at construction and throws ENOENT if it is missing — one line
 * after the warning above promises 404s instead. So a fresh clone running `npm run dev`, which
 * starts this process before anything has been built, got a dead BFF and a stack trace rather
 * than the degraded-but-running server the warning describes.
 */
const assets = !clientDirExists
  ? (_req: IncomingMessage, _res: ServerResponse, next: () => void): void => next()
  : sirv(cfg.clientDir, {
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
        // SAMEORIGIN rather than DENY, for the same reason `frame-ancestors` is 'self': MSAL renews
        // tokens through a hidden iframe that Entra redirects back to /auth/callback on this origin,
        // and DENY blocks a page from being framed even by itself. Cross-origin framing — the actual
        // clickjacking vector — is still refused.
        if (cfg.authMode !== 'dev') res.setHeader('x-frame-options', 'SAMEORIGIN');
        // Hashed assets are immutable; index.html must never be cached or a deploy won't take.
        //
        // Keyed off what is actually SERVED, not what was requested. `single: true` answers every
        // client route with index.html, so testing the request path missed `/c/:id` and `/s/:id` —
        // precisely the URLs a user reloads or has bookmarked. Those got a validator and no
        // `cache-control`, so a deploy did not take for the people most likely to have the app open.
        // Anything without a file extension is a client route, and therefore the shell.
        const servesTheShell =
          pathname === '/' || !pathname.slice(pathname.lastIndexOf('/')).includes('.');
        if (servesTheShell) {
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
// sporadic 502s.
server.keepAliveTimeout = 120_000;
server.headersTimeout = 125_000;
// `requestTimeout` bounds time to RECEIVE a request, not to respond — so it never had anything to
// do with the 600s SSE responses the previous `0` was set to protect. Disabling it only removed
// the sole bound on the attachment upload path, where a client can hold a socket open by sending
// a body one byte at a time and nothing reaps it. Five minutes is far above any real upload here
// and far below forever.
server.requestTimeout = 300_000;

server.on('error', (err: NodeJS.ErrnoException) => {
  // EADDRINUSE is the common one and deserves the same treatment as a bad config value, which
  // this file otherwise takes care to report readably.
  log.error(
    err.code === 'EADDRINUSE'
      ? `config: port ${cfg.port} is already in use`
      : `server error: ${err.message}`,
  );
  process.exit(1);
});

server.listen(cfg.port, cfg.bindHost, () => {
  log.info(`chemclaw3-ui listening on http://${cfg.bindHost}:${cfg.port}`);
  log.info(`proxying /api -> ${cfg.apiUrl}`);
  log.info(`auth mode: ${cfg.authMode}`);

  if (cfg.authMode === 'dev' && cfg.bindHost !== '127.0.0.1' && cfg.bindHost !== 'localhost') {
    // Mirrors the backend's own fail-closed warning. With CHEMCLAW_ENTRA_REQUIRED=false every
    // request upstream runs as a shared dev principal with all authorization gates open, so a
    // network-reachable UI in that mode is an open door to the agent and its tools.
    // `error`, not `warn`. This is the only notice that the front door is open, and at warn level
    // `LOG_LEVEL=error` — a perfectly ordinary production setting — deleted it entirely, leaving
    // nothing at all to say the app was reachable with no sign-in.
    //
    // Deliberately still a log line rather than a refusal to boot: docker-compose.yml and start.sh
    // both bind 0.0.0.0 with AUTH_MODE=dev on purpose, so failing closed here would break the
    // documented quickstart. Whether that combination should be allowed at all is a policy call
    // for this repo's owners, not something to change underneath them.
    log.error(
      'SECURITY: AUTH_MODE=dev on a non-loopback bind. No sign-in is required and the backend ' +
        'is almost certainly running with CHEMCLAW_ENTRA_REQUIRED=false, meaning every request ' +
        'is a shared principal with all authorization gates open. Do not expose this beyond a ' +
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
