/**
 * The BFF's entry point: validate the configuration, then serve.
 *
 * Everything this process actually *does* lives in `app.ts`, which builds the server without
 * starting it — that is what makes the request handling and its socket limits testable against
 * real sockets instead of only measurable by hand.
 */

import { cfg, isLoopbackHost, validateConfig } from './config.ts';
import { createBffServer } from './app.ts';
import { log } from './log.ts';

const problems = validateConfig();
if (problems.length > 0) {
  for (const problem of problems) log.error(`config: ${problem}`);
  process.exit(1);
}

const server = createBffServer();

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

  if (cfg.allowFraming) {
    log.warn(
      'SECURITY: ALLOW_FRAMING=true. This page may be framed by any origin, so a control a ' +
        'reader clicks here can have been positioned by somebody else. Preview hosts only.',
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
