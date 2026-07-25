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
}

export function runtimeConfig(): RuntimeConfig {
  return {
    authMode: cfg.authMode,
    entraTenantId: cfg.entraTenantId,
    entraClientId: cfg.entraClientId,
    apiScope: cfg.apiScope,
    apiBase: '/api',
    appVersion: cfg.appVersion,
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
