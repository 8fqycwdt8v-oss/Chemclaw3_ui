/**
 * `GET /config.js` — the runtime configuration bridge.
 *
 * Vite inlines `import.meta.env.VITE_*` at build time, so a SPA configured that way needs one
 * image per environment. Instead the server emits a tiny script assigning `window.__CHEMCLAW_CONFIG__`
 * from its own `process.env`, and `index.html` loads it before the module bundle. One image,
 * any tenant, no rebuild.
 */

import type { ServerResponse } from 'node:http';
import { cfg } from './config.ts';

export interface RuntimeConfig {
  authMode: 'dev' | 'msal';
  entraTenantId: string;
  entraClientId: string;
  apiScope: string;
  apiBase: string;
  appVersion: string;
  /** See `warmSessions` in src/env.ts — a kill switch for pre-creating backend sessions. */
  warmSessions: boolean;
  /** The service's privileged app-role names, so the SPA can hide what would 403. */
  reviewerRoles: string[];
  /**
   * What the browser records — see `logLevel` in src/env.ts.
   *
   * The union is written out here rather than imported from `src/`, exactly as `authMode` is: this
   * interface is one half of a seam, the SPA's `RuntimeConfig` is the other, and
   * `tests/runtimeConfig.test.ts` asserts the two are mutually assignable — which is what catches a
   * drift that a shared import would hide by construction. A server-side import of `src/lib` would
   * also drag the browser's `config` into the BFF bundle.
   */
  logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  /** The service's message-length cap, so the composer refuses where the service refuses. */
  maxMessageChars: number;
}

const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;

/** `CLIENT_LOG_LEVEL` as a level the SPA will accept. A typo must not silence the record, so an
 *  unrecognised value falls back to `info` rather than to nothing. */
const clientLogLevel = (): RuntimeConfig['logLevel'] =>
  LOG_LEVELS.find((level) => level === cfg.clientLogLevel) ?? 'info';

export function runtimeConfig(): RuntimeConfig {
  return {
    authMode: cfg.authMode,
    entraTenantId: cfg.entraTenantId,
    entraClientId: cfg.entraClientId,
    apiScope: cfg.apiScope,
    apiBase: '/api',
    appVersion: cfg.appVersion,
    warmSessions: cfg.warmSessions,
    reviewerRoles: cfg.reviewerRoles,
    logLevel: clientLogLevel(),
    maxMessageChars: cfg.maxMessageChars,
  };
}

export function renderConfigScript(config: RuntimeConfig = runtimeConfig()): string {
  // Escape `<` so a configured value containing "</script>" cannot break out of the tag it is
  // embedded in. These values are operator-supplied, not user-supplied, but the cost is one
  // replace and the failure mode would be script injection.
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  return `window.__CHEMCLAW_CONFIG__=${json};`;
}

export function serveConfigJs(res: ServerResponse): void {
  const body = renderConfigScript();
  res.writeHead(200, {
    'content-type': 'application/javascript; charset=utf-8',
    // Never cache: the whole point is that it tracks the container's environment.
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}
