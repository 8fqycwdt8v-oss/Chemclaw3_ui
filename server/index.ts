/**
 * The BFF's entry point: validate the configuration, then serve.
 *
 * Everything this process actually *does* lives in `app.ts`, which builds the server without
 * starting it — that is what makes the request handling and its socket limits testable against
 * real sockets instead of only measurable by hand. What is left here is the process lifecycle:
 * refusing to start, starting, saying so, and stopping in a way a load balancer can follow.
 */

import { cfg, isLoopbackHost, validateConfig } from './config.ts';
import { createBffServer } from './app.ts';
import { log } from './log.ts';
import { beginDraining } from './ready.ts';

/**
 * Report a fatal condition in the shape everything else here writes, then stop.
 *
 * Every one of the three callers below existed as an *unhandled* condition first, and each printed
 * a raw V8 stack to stderr — twenty-odd lines a JSON log stack parses as twenty-odd unstructured
 * records, so `logger=chemclaw3-ui level=ERROR` found nothing at all about the one event that
 * stopped the pod from serving. The exit code is 1 in every case, which is what Node already did:
 * the record is the change, not the lifecycle.
 */
function die(message: string, fields: Record<string, unknown>): never {
  log.error(message, fields);
  process.exit(1);
}

/**
 * A rejected promise nobody caught, and an exception nobody caught.
 *
 * Installed before anything can throw. Node 22 already treats both as fatal, so these handlers do
 * not keep a process alive that has lost an invariant — resuming after `uncaughtException` is
 * unsafe and the documentation says so. What they add is the record: the same JSON line as every
 * other error this process writes, carrying the message and the stack as *fields* rather than as
 * loose text, so the failure is findable by the same query that finds an upstream error.
 *
 * The two `void`ed promises in the request listener used to be the realistic producer of the first
 * one; they have `.catch()` handlers now (`app.ts::failRequest`), so this is a net rather than the
 * plan.
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
 * A server that cannot listen, reported like everything else this process reports.
 *
 * `listen` fails asynchronously, on the server's `error` event, and with no listener Node rethrows
 * it as an uncaught exception. Measured: a second instance on a held port printed
 * `Error: listen EADDRINUSE` plus a stack and exited 1, with the two startup lines above it in
 * JSON and nothing structured about the failure itself — so the deployment that keeps restarting
 * is the one whose logs say least about why.
 *
 * **This does not cover file-descriptor exhaustion, and the finding that asked for it said it
 * did.** Measured with the server process at `ulimit -n 96` while 300 connections arrived from
 * another process: no `error` event, no exception, the process still listening. Node drops what it
 * cannot accept, silently. `server.maxConnections` is what turns that into a ceiling this process
 * picked; it is not a crash being caught here.
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

  if (cfg.allowFraming) {
    log.warn(
      'SECURITY: ALLOW_FRAMING=true. This page may be framed by any origin, so a control a ' +
        'reader clicks here can have been positioned by somebody else. Preview hosts only.',
    );
  }
});

/**
 * How long to keep answering after `server.close()` before giving up on what is still open.
 *
 * Unchanged from when this was the whole shutdown: an SSE stream holds the server open for as long
 * as its turn runs, which is up to the backend's 600 s wall clock, so waiting for `close` to call
 * back is waiting for ever. What moved is *when* it starts — after the drain, not instead of it.
 */
const CLOSE_GRACE_MS = 5_000;

/**
 * Stop taking new work before stopping.
 *
 * `server.close()` used to run synchronously in this handler, and the listening socket goes with
 * it. Measured end to end against a running BFF: SIGTERM at t=301 ms, `/readyz` answering 200 at
 * t=204 ms, `UND_ERR_SOCKET` at t=306 ms, `ECONNREFUSED` from t=403 ms, process exited 0 at
 * t=314 ms. `/readyz` never returned a single 503 — it went from serving to refusing in about a
 * tenth of a second, so nothing ever told a load balancer to stop sending, and everything it sent
 * in the meantime was a connection error a chemist reads as the app being broken.
 *
 * The fix is the ordinary one and its whole content is the wait: fail readiness, keep serving,
 * and only then close. `cfg.shutdownDrainMs` defaults to one Kubernetes readiness period so at
 * least one probe observes the 503. `/healthz` stays 200 throughout — a draining pod is still
 * serving what it already has, and a liveness failure would restart it out from under those
 * requests.
 *
 * **SIGTERM only.** SIGINT is a human at a terminal pressing ctrl-C, with no load balancer to tell
 * anything to; making them wait ten seconds for a drain nobody is watching would be a worse dev
 * loop bought with no availability.
 *
 * The whole sequence is bounded by `shutdownDrainMs + CLOSE_GRACE_MS` — 15 s on the defaults —
 * which has to stay under the deployment's own `terminationGracePeriodSeconds` (Kubernetes
 * defaults to 30 s) or the orchestrator's SIGKILL lands mid-drain.
 */
const closeAndExit = (signal: string): void => {
  log.info('closing listener', { signal });
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
