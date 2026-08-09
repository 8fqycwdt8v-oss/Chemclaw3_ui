/**
 * `GET /config.js` — the runtime configuration bridge.
 *
 * Vite inlines `import.meta.env.VITE_*` at build time, so a SPA configured that way needs one
 * image per environment. Instead the server emits a tiny script assigning `window.__CHEMCLAW_CONFIG__`
 * from its own `process.env`, and `index.html` loads it before the module bundle. One image,
 * any tenant, no rebuild.
 */

import type { ServerResponse } from 'node:http';
import { cfg, type AuthMode } from './config.ts';

export interface RuntimeConfig {
  authMode: AuthMode;
  entraTenantId: string;
  entraClientId: string;
  apiScope: string;
  apiBase: string;
  appVersion: string;
}

/**
 * Note what is emitted and what is not.
 *
 * The tenant, client id and scope are only of any use to browser-MSAL, and they are public values
 * — the client id is in every authorize URL, the scope in every token request. They are still
 * omitted in `bff` mode, because in that mode nothing in the browser talks to Entra and shipping
 * configuration a page cannot use is how a page ends up using it.
 *
 * `ENTRA_CLIENT_SECRET` and `SESSION_SECRET` are of course absent, and the type makes that
 * structural rather than a matter of remembering: `RuntimeConfig` has no field for either.
 */
export function runtimeConfig(): RuntimeConfig {
  const browserMsal = cfg.authMode === 'msal-spa';
  return {
    authMode: cfg.authMode,
    entraTenantId: browserMsal ? cfg.entraTenantId : '',
    entraClientId: browserMsal ? cfg.entraClientId : '',
    apiScope: browserMsal ? cfg.apiScope : '',
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
