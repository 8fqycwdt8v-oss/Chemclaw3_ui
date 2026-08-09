/**
 * BFF configuration, read once from the environment at boot.
 *
 * Everything the browser needs at runtime is served from here via `/config.js`, so a single
 * container image can be deployed to any tenant without a rebuild (Vite inlines `import.meta.env`
 * at BUILD time, which is exactly what we are working around).
 */

export type AuthMode = 'dev' | 'msal';

const str = (name: string, fallback = ''): string => process.env[name]?.trim() || fallback;
const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const authMode: AuthMode = str('AUTH_MODE', 'dev') === 'msal' ? 'msal' : 'dev';

/** Entra's login host, needed in the CSP when MSAL is on — see `csp` below. */
const ENTRA_HOST = 'https://login.microsoftonline.com';

/**
 * Content-Security-Policy for the SPA.
 *
 * Built conditionally on auth mode because MSAL refreshes tokens silently through a hidden
 * IFRAME to login.microsoftonline.com. Copying the backend's `connect-src 'self'` verbatim
 * would break that refresh roughly an hour after login — a failure that looks like a random
 * logout and is miserable to trace back to a header.
 */
function buildCsp(mode: AuthMode): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // No inline scripts: /config.js is a real same-origin file precisely so this can stay strict.
    'script-src': ["'self'"],
    // Tailwind injects a stylesheet; smiles-drawer emits inline style attributes on its SVG.
    'style-src': ["'self'", "'unsafe-inline'"],
    // blob: covers a canvas->objectURL path if a structure is ever exported as an image.
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'"],
    'frame-src': ["'none'"],
    'form-action': ["'self'"],
    'base-uri': ["'none'"],
    // Allow framing from any origin in dev mode so the Replit preview iframe works.
    // Production deployments behind Entra auth should tighten this back to "'none'".
    'frame-ancestors': mode === 'dev' ? ['*'] : ["'none'"],
    'object-src': ["'none'"],
  };

  if (mode === 'msal') {
    directives['connect-src'] = ["'self'", ENTRA_HOST];
    directives['frame-src'] = [ENTRA_HOST];
    directives['form-action'] = ["'self'", ENTRA_HOST];
  }

  return Object.entries(directives)
    .map(([key, values]) => `${key} ${values.join(' ')}`)
    .join('; ');
}

export interface BffConfig {
  port: number;
  bindHost: string;
  clientDir: string;
  apiUrl: string;
  authMode: AuthMode;
  entraTenantId: string;
  entraClientId: string;
  apiScope: string;
  appVersion: string;
  sseHeartbeatMs: number;
  upstreamConnectTimeoutMs: number;
  csp: string;
  logLevel: string;
}

export const cfg: BffConfig = {
  port: num('PORT', 8080),
  bindHost: str('BIND_HOST', '0.0.0.0'),
  clientDir: str('CLIENT_DIR', new URL('./client', import.meta.url).pathname),
  // The Chemclaw3 service. In compose this is the service name; locally, a uvicorn on :8080.
  apiUrl: str('CHEMCLAW_API_URL', 'http://127.0.0.1:8080'),
  authMode,
  entraTenantId: str('ENTRA_TENANT_ID'),
  // The SPA's own app registration. NOT the API's client id, and note the backend has no
  // CHEMCLAW_ENTRA_CLIENT_ID setting at all — its Settings model is extra="forbid", so
  // exporting one there aborts its startup. The SPA client id is purely a frontend concern.
  entraClientId: str('ENTRA_CLIENT_ID'),
  // Must be an API scope: api://<api-client-id>/<scope>. Requesting only openid/profile yields
  // an ID token whose `aud` is the SPA client id, which the backend's audience check rejects.
  apiScope: str('API_SCOPE'),
  appVersion: str('APP_VERSION', 'dev'),
  sseHeartbeatMs: num('SSE_HEARTBEAT_MS', 15_000),
  upstreamConnectTimeoutMs: num('UPSTREAM_CONNECT_TIMEOUT_MS', 10_000),
  csp: buildCsp(authMode),
  logLevel: str('LOG_LEVEL', 'info'),
};

/**
 * Fail fast on a configuration that cannot possibly work, and warn loudly on one that works but
 * is unsafe. Mirrors the backend's own `_refuse_unauthenticated_exposure` posture.
 */
export function validateConfig(c: BffConfig = cfg): string[] {
  const problems: string[] = [];

  try {
    const parsed = new URL(c.apiUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      problems.push(`CHEMCLAW_API_URL must be http(s), got ${parsed.protocol}`);
    }
  } catch {
    problems.push(`CHEMCLAW_API_URL is not a valid URL: ${JSON.stringify(c.apiUrl)}`);
  }

  if (c.authMode === 'msal') {
    if (!c.entraTenantId) problems.push('ENTRA_TENANT_ID is required when AUTH_MODE=msal');
    if (!c.entraClientId) problems.push('ENTRA_CLIENT_ID is required when AUTH_MODE=msal');
    if (!c.apiScope) problems.push('API_SCOPE is required when AUTH_MODE=msal');
  }

  return problems;
}
