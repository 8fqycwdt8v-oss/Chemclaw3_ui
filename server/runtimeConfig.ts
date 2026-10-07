/**
 * `GET /config.js`: emits `window.__CHEMCLAW_CONFIG__` from this process's environment, loaded by
 * `index.html` before the bundle, so one image serves any tenant without a rebuild.
 */

import type { ServerResponse } from 'node:http';
import { cfg } from './config.ts';

export interface RuntimeConfig {
  authMode: 'dev' | 'msal';
  entraTenantId: string;
  /**
   * The resolved MSAL authority (`entraAuthority` in `server/config.ts`), so the SPA and this
   * process's CSP share one value.
   */
  entraAuthority: string;
  entraClientId: string;
  apiScope: string;
  apiBase: string;
  appVersion: string;
  /** See `warmSessions` in src/env.ts — a kill switch for pre-creating backend sessions. */
  warmSessions: boolean;
  /** The service's privileged app-role names, so the SPA can hide what would 403. */
  reviewerRoles: string[];
  /**
   * What the browser records (see `logLevel` in src/env.ts). The union is written out rather than
   * imported from `src/`: `tests/runtimeConfig.test.ts` asserts this and the SPA's `RuntimeConfig`
   * are mutually assignable, which a shared import would hide, and it keeps browser code out of the
   * BFF bundle.
   */
  logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  /** The service's message-length cap, so the composer refuses where the service refuses. */
  maxMessageChars: number;
  /** How often an open shared conversation reads its session's line, in ms — `SHARED_POLL_MS`.
   *  See `sharedPollMs` in src/env.ts. */
  sharedPollMs: number;
  /**
   * The HTML sandbox origin, or `''` when the second listener is not running, so the SPA never
   * frames an unserved origin.
   */
  sandboxOrigin: string;
  /**
   * The origin the app is meant to be reached at (`APP_ORIGIN`), or `''`: the one origin the
   * sandbox shell accepts content from. Published so a page opened elsewhere shows the artefact as
   * source with both origins named.
   */
  appOrigin: string;
  /**
   * Whether an `html` artefact's script runs as soon as shown (`HTML_SCRIPTS_DEFAULT`, default on).
   * Off restores the per-view "Run scripts".
   */
  htmlScriptsDefault: boolean;
  /**
   * Where the browser reads the README (`DOCS_BASE_URL`); configurable because github.com is
   * unreachable when air-gapped.
   */
  docsBaseUrl: string;
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
    entraAuthority: cfg.entraAuthority,
    entraClientId: cfg.entraClientId,
    apiScope: cfg.apiScope,
    apiBase: '/api',
    appVersion: cfg.appVersion,
    warmSessions: cfg.warmSessions,
    reviewerRoles: cfg.reviewerRoles,
    logLevel: clientLogLevel(),
    maxMessageChars: cfg.maxMessageChars,
    sharedPollMs: cfg.sharedPollMs,
    sandboxOrigin: cfg.sandboxEnabled ? cfg.sandboxOrigin : '',
    appOrigin: cfg.appOrigin,
    htmlScriptsDefault: cfg.htmlScriptsDefault,
    docsBaseUrl: cfg.docsBaseUrl,
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
