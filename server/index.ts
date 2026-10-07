/**
 * The BFF's entry point: validate the configuration, then serve. Request handling lives in
 * `app.ts`; this is the process lifecycle — refuse to start, start, log, and shut down so a load
 * balancer can follow.
 */

import { cfg, isLoopbackHost, validateConfig } from './config.ts';
import { createBffServer, createSandboxServer } from './app.ts';
import { log } from './log.ts';
import { beginDraining } from './ready.ts';

/** Log a fatal condition as a structured JSON line, then exit 1. */
function die(message: string, fields: Record<string, unknown>): never {
  log.error(message, fields);
  process.exit(1);
}

/**
 * Log uncaught rejections and exceptions as structured lines. Node 22 already treats both as fatal;
 * these add the record, not survival.
 */
process.on('unhandledRejection', (reason: unknown) => {
  die('unhandled promise rejection', {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

process.on('uncaughtException', (error: Error) => {
  die('uncaught exception', { error: error.message, stack: error.stack });
});

const problems = validateConfig();
if (problems.length > 0) {
  for (const problem of problems) log.error(`config: ${problem}`);
  process.exit(1);
}

const server = createBffServer();

/**
 * A listen failure (`EADDRINUSE`, …) arrives as an `error` event; report it as a structured line
 * and exit. File-descriptor exhaustion does not surface here (Node drops what it cannot accept; see
 * `maxConnections`).
 */
server.on('error', (error: NodeJS.ErrnoException) => {
  die('server error', {
    code: error.code ?? 'EUNKNOWN',
    error: error.message,
    address: `${cfg.bindHost}:${cfg.port}`,
  });
});

server.listen(cfg.port, cfg.bindHost, () => {
  log.info('listening', {
    address: `http://${cfg.bindHost}:${cfg.port}`,
    upstream: cfg.apiUrl,
    auth_mode: cfg.authMode,
    app_version: cfg.appVersion,
    log_level: cfg.logLevel,
    client_log_level: cfg.clientLogLevel,
  });

  if (cfg.authMode === 'dev' && !isLoopbackHost(cfg.bindHost)) {
    // Only reachable with `ALLOW_INSECURE_AUTH=true`; logged as a deliberate choice.
    log.warn(
      `SECURITY: AUTH_MODE=dev on a non-loopback bind (${cfg.bindHost}) with ` +
        'ALLOW_INSECURE_AUTH=true. No sign-in is required and the backend is almost certainly ' +
        'running with CHEMCLAW_ENTRA_REQUIRED=false, meaning every request is a shared principal ' +
        'with all authorization gates open. Do not expose this beyond a trusted dev network.',
    );
  }

  if (cfg.authMode === 'msal' && cfg.rawEntraAuthority) {
    // A non-default authority is legitimate but logged; the service still validates issuer and
    // keys.
    log.warn(
      `ENTRA_AUTHORITY=${cfg.entraAuthority}: sign-in goes to this authority, not to ` +
        'login.microsoftonline.com, and the CSP opens its origin instead. Chemclaw3 must trust ' +
        'the same issuer (CHEMCLAW_ENTRA_ISSUER / CHEMCLAW_ENTRA_JWKS_URL).',
    );
  }

  if (cfg.allowFraming) {
    log.warn(
      'SECURITY: ALLOW_FRAMING=true. This page may be framed by any origin, so a control a ' +
        'reader clicks here can have been positioned by somebody else. Preview hosts only.',
    );
  }
});

/** The HTML sandbox listener, when configured; a bind failure is fatal like the app's. */
const sandbox = cfg.sandboxEnabled ? createSandboxServer() : null;

/**
 * One startup line says whether the sandbox is on and why: `on` once bound, `off` with its reason
 * (a warning when `ALLOW_FRAMING` overrode it).
 */
if (!sandbox) {
  const record = cfg.allowFraming && cfg.rawSandboxOrigin ? log.warn : log.info;
  record(`html sandbox off: ${cfg.sandboxReason}`, { sandbox: 'off', reason: cfg.sandboxReason });
}

if (sandbox) {
  sandbox.on('error', (error: NodeJS.ErrnoException) => {
    die('sandbox server error', {
      code: error.code ?? 'EUNKNOWN',
      error: error.message,
      address: `${cfg.sandboxBindHost}:${cfg.sandboxPort}`,
    });
  });
  sandbox.listen(cfg.sandboxPort, cfg.sandboxBindHost, () => {
    const scripts = cfg.htmlScriptsDefault ? 'run by default' : 'off until "Run scripts"';
    log.info(`html sandbox on: ${cfg.sandboxReason}; artefact scripts ${scripts}`, {
      sandbox: 'on',
      reason: cfg.sandboxReason,
      address: `http://${cfg.sandboxBindHost}:${cfg.sandboxPort}`,
      sandbox_origin: cfg.sandboxOrigin,
      app_origin: cfg.appOrigin,
      html_scripts_default: cfg.htmlScriptsDefault ? 'on' : 'off',
    });
    // Different ports on one hostname are different origins but the same site; warn, since the
    // documented shape is a separate hostname.
    if (
      new URL(cfg.sandboxOrigin).hostname === new URL(cfg.appOrigin).hostname &&
      !isLoopbackHost(new URL(cfg.appOrigin).hostname)
    ) {
      log.warn(
        `SANDBOX_ORIGIN ${cfg.sandboxOrigin} shares a hostname with APP_ORIGIN ${cfg.appOrigin}. ` +
          'Serve the sandbox from a distinct hostname in deployment (README, "HTML sandbox").',
      );
    }
  });
}

/**
 * How long to wait after `server.close()` before exiting: open SSE streams would otherwise hold it
 * for up to 600 s.
 */
const CLOSE_GRACE_MS = 5_000;

/**
 * On SIGTERM, fail readiness first and keep serving for `cfg.shutdownDrainMs` (one readiness
 * period), then close, so a load balancer stops sending before connections are refused. `/healthz`
 * stays 200. SIGINT (a developer's ctrl-C) closes at once. Total `shutdownDrainMs + CLOSE_GRACE_MS`
 * must stay under `terminationGracePeriodSeconds`.
 */
const closeAndExit = (signal: string): void => {
  log.info('closing listener', { signal });
  // The sandbox serves one static page and holds no stream, so it closes without a drain.
  sandbox?.close();
  server.close(() => process.exit(0));
  // Open SSE streams hold the server open indefinitely; don't wait forever on them.
  setTimeout(() => process.exit(0), CLOSE_GRACE_MS).unref();
};

process.on('SIGTERM', () => {
  log.info('draining', { signal: 'SIGTERM', drain_ms: cfg.shutdownDrainMs });
  beginDraining();
  // Deliberately not `unref`ed: the listening server keeps the loop alive anyway, and a drain that
  // could be skipped by an idle event loop is not a drain.
  setTimeout(() => closeAndExit('SIGTERM'), cfg.shutdownDrainMs);
});

process.on('SIGINT', () => {
  log.info('shutting down', { signal: 'SIGINT' });
  closeAndExit('SIGINT');
});
