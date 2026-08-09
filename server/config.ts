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
const bool = (name: string, fallback = false): boolean => {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
};

/**
 * The raw `AUTH_MODE`, kept alongside the resolved mode so `validateConfig` can refuse a typo.
 *
 * This used to be `str('AUTH_MODE', 'dev') === 'msal' ? 'msal' : 'dev'`, which resolved *every*
 * unrecognised value to the unauthenticated mode — so `AUTH_MODE=MSAL`, or `entra`, or a trailing
 * newline from a secret manager, booted a production deployment with no sign-in, `frame-ancestors
 * *`, and no `X-Frame-Options`. A mode nobody named is a configuration error, not a default.
 */
const rawAuthMode = str('AUTH_MODE', 'dev');
const authMode: AuthMode = rawAuthMode === 'msal' ? 'msal' : 'dev';
const authModeIsValid = rawAuthMode === 'msal' || rawAuthMode === 'dev';

/** Loopback names, for the unauthenticated-exposure check. Mirrors the backend's `_LOOPBACK_HOSTS`. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

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
  /** Cap on a proxied request body, mirroring the backend's own 4 MB limit. */
  maxBodyBytes: number;
  /** Explicit, conscious opt-out from the unauthenticated-exposure refusal below. */
  allowInsecure: boolean;
  /** The raw `AUTH_MODE` as given, so a typo can be named in the refusal. */
  rawAuthMode: string;
  authModeIsValid: boolean;
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
  // 4 MB, the same cap the backend enforces (`chemclaw.core.asgi.BodySizeLimit`). Matching it
  // means an oversized upload is refused here, at the edge, instead of being streamed across the
  // internal network for the backend to reject — and the caller gets the same 413 either way.
  maxBodyBytes: num('MAX_BODY_BYTES', 4_000_000),
  allowInsecure: bool('ALLOW_INSECURE_AUTH', false),
  rawAuthMode,
  authModeIsValid,
  csp: buildCsp(authMode),
  logLevel: str('LOG_LEVEL', 'info'),
};

/** Whether `host` is a loopback bind — i.e. not reachable from off the machine. */
export const isLoopbackHost = (host: string): boolean => LOOPBACK_HOSTS.has(host.trim());

/**
 * Fail fast on a configuration that cannot possibly work, or that is unsafe.
 *
 * This docstring used to claim it "mirrors the backend's own `_refuse_unauthenticated_exposure`
 * posture" while doing no such thing: dev auth on a non-loopback bind produced a `log.warn` and
 * booted anyway. The backend refuses, and says why in its own comment — "the earlier warn-and-boot
 * was one missed log line from an open deployment". That is precisely what this was.
 *
 * So the check is now a *problem*, not a warning, and `ALLOW_INSECURE_AUTH=true` is the explicit
 * opt-out — the same shape and the same name-in-spirit as `CHEMCLAW_SERVICE_ALLOW_INSECURE`. The
 * two local-dev paths are untouched: a loopback bind is exempt, and so is `AUTH_MODE=msal`.
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

  if (!c.authModeIsValid) {
    problems.push(
      `AUTH_MODE ${JSON.stringify(c.rawAuthMode)} is not a valid mode (expected "msal" or ` +
        '"dev"). Refusing to start rather than falling back to unauthenticated access.',
    );
  }

  if (c.authMode === 'msal') {
    if (!c.entraTenantId) problems.push('ENTRA_TENANT_ID is required when AUTH_MODE=msal');
    if (!c.entraClientId) problems.push('ENTRA_CLIENT_ID is required when AUTH_MODE=msal');
    if (!c.apiScope) problems.push('API_SCOPE is required when AUTH_MODE=msal');
  }

  if (c.authMode === 'dev' && !isLoopbackHost(c.bindHost) && !c.allowInsecure) {
    problems.push(
      `SECURITY: AUTH_MODE=dev but the UI binds a non-loopback interface (${c.bindHost}) — ` +
        'every visitor would drive the agent as the shared dev principal with all authorization ' +
        'gates OPEN, from any origin (dev mode also serves frame-ancestors * and no ' +
        'X-Frame-Options). Set AUTH_MODE=msal for any shared/exposed deployment, bind ' +
        '127.0.0.1 for local dev, or set ALLOW_INSECURE_AUTH=true to explicitly accept an ' +
        'unauthenticated, network-exposed UI.',
    );
  }

  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) {
    problems.push(`PORT must be an integer in 1-65535, got ${c.port}`);
  }
  // A negative interval reaches `setInterval` as a clamped 1 ms, which writes a heartbeat frame
  // every millisecond into every open stream. 0 is legal and means "disabled" (see `proxy.ts`).
  if (!Number.isFinite(c.sseHeartbeatMs) || c.sseHeartbeatMs < 0) {
    problems.push(`SSE_HEARTBEAT_MS must be >= 0, got ${c.sseHeartbeatMs}`);
  }
  if (!Number.isFinite(c.upstreamConnectTimeoutMs) || c.upstreamConnectTimeoutMs < 0) {
    problems.push(`UPSTREAM_CONNECT_TIMEOUT_MS must be >= 0, got ${c.upstreamConnectTimeoutMs}`);
  }
  if (!Number.isFinite(c.maxBodyBytes) || c.maxBodyBytes < 1) {
    problems.push(`MAX_BODY_BYTES must be >= 1, got ${c.maxBodyBytes}`);
  }

  return problems;
}
