/**
 * BFF configuration, read once from the environment at boot.
 *
 * Everything the browser needs at runtime is served from here via `/config.js`, so a single
 * container image can be deployed to any tenant without a rebuild (Vite inlines `import.meta.env`
 * at BUILD time, which is exactly what we are working around).
 */

export type AuthMode = 'dev' | 'msal';

const str = (name: string, fallback = ''): string => process.env[name]?.trim() || fallback;
const bool = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
};
const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};
/**
 * The raw `AUTH_MODE` as given, kept beside the resolved mode so `validateConfig` can refuse a typo.
 *
 * This used to be `str('AUTH_MODE', 'dev') === 'msal' ? 'msal' : 'dev'`, which resolved *every*
 * unrecognised value to the unauthenticated mode. So `AUTH_MODE=MSAL`, or `entra`, or a value
 * carrying a trailing newline from a secret manager, booted a production deployment with no
 * sign-in, `frame-ancestors *`, and no `X-Frame-Options` — silently, and looking exactly like a
 * working deployment until someone noticed nobody had been asked to log in. A mode nobody named is
 * a configuration error, not a default.
 */
const rawAuthMode = str('AUTH_MODE', 'dev');

const MODES: Record<string, AuthMode> = { dev: 'dev', msal: 'msal' };

/**
 * Still `dev` on an unrecognised value, because `cfg` is a plain object built at module scope and
 * has nowhere to throw to. The refusal is `validateConfig`'s job — `authModeIsValid` is what
 * carries the fact there. What matters is that the process does not *serve* in this state.
 */
const authMode: AuthMode = MODES[rawAuthMode] ?? 'dev';
const authModeIsValid = rawAuthMode in MODES;

/** Loopback names, for the unauthenticated-exposure check. Mirrors the backend's `_LOOPBACK_HOSTS`. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export const isLoopbackHost = (host: string): boolean => LOOPBACK_HOSTS.has(host.trim());

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
    //
    // `wasm-unsafe-eval` is what lets `WebAssembly.instantiate` run at all, and both chemistry
    // dependencies need it: RDKit (`src/chem/rdkit.ts`) and Ketcher's Indigo worker
    // (`src/chem/sketcher.ketcher.tsx`). It permits WASM compilation and nothing else — it does
    // NOT re-open `eval` or inline script, which is exactly why the narrow token exists.
    //
    // Verify this against the BFF, not against Vite. The dev server serves index.html itself and
    // never sends this header, so a missing directive here fails ONLY in the container: check
    // `http://localhost:3000`, not `:5173`.
    'script-src': ["'self'", "'wasm-unsafe-eval'"],
    // Ketcher runs Indigo in a Web Worker created from a same-origin module URL. Without this the
    // sketcher dialog mounts and then dies on the first chemistry operation — and `worker-src`
    // does NOT fall back to `script-src` in browsers that implement it, so it has to be stated.
    'worker-src': ["'self'"],
    // Tailwind injects a stylesheet; RDKit and Ketcher both emit inline style attributes.
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
  /** The raw `AUTH_MODE` as given, so a typo can be named in the refusal rather than guessed at. */
  rawAuthMode: string;
  authModeIsValid: boolean;
  /** Opt-in to serving `AUTH_MODE=dev` on a non-loopback bind. See `validateConfig`. */
  allowInsecureAuth: boolean;
  entraTenantId: string;
  entraClientId: string;
  apiScope: string;
  appVersion: string;
  sseHeartbeatMs: number;
  upstreamConnectTimeoutMs: number;
  warmSessions: boolean;
  reviewerRoles: string[];
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
  rawAuthMode,
  authModeIsValid,
  // Deliberately not defaulted from anything else. Exposing an unauthenticated UI is a decision,
  // and the only way to record a decision is to make someone write it down.
  allowInsecureAuth: bool('ALLOW_INSECURE_AUTH', false),
  entraTenantId: str('ENTRA_TENANT_ID'),
  // The SPA's own app registration. NOT the API's client id, and note the backend has no
  // CHEMCLAW_ENTRA_CLIENT_ID setting at all — its Settings model is extra="forbid", so
  // exporting one there aborts its startup. The SPA client id is purely a frontend concern.
  entraClientId: str('ENTRA_CLIENT_ID'),
  // Must be an API scope: api://<api-client-id>/<scope>. Requesting only openid/profile yields
  // an ID token whose `aud` is the SPA client id, which the backend's audience check rejects.
  apiScope: str('API_SCOPE'),
  appVersion: str('APP_VERSION', 'dev'),
  // Pre-creating a session while the user types costs the service one live-session slot per
  // conversation typed into, sent or not. Default on; switchable without a client rebuild.
  warmSessions: bool('WARM_SESSIONS', true),
  // The app roles that may decide a knowledge proposal or cancel a durable job. These are the
  // service's own `CHEMCLAW_ENTRA_PRIVILEGED_ROLES`, and they have to be told to this process
  // rather than guessed: the names are chosen per deployment, so a hardcoded list would be wrong
  // everywhere. Used only to hide affordances that would come back 403 — the service enforces.
  //
  // Empty is meaningful and matches the service's posture: under enforcement it fails closed, so
  // nobody is offered a decision, which is a misconfiguration to notice rather than paper over.
  reviewerRoles: str('REVIEWER_ROLES')
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean),
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

  // The docstring above has claimed to mirror `_refuse_unauthenticated_exposure` since this
  // function was written, while only logging a warning — and a warning on a container's stdout is
  // not a refusal. With `CHEMCLAW_ENTRA_REQUIRED=false` upstream, every visitor to a reachable
  // dev-mode UI drives the agent as a shared principal with all authorization gates open.
  //
  // `authModeIsValid` guards this so a typo produces one error naming the typo, rather than that
  // error plus a confusing second one about a dev mode nobody asked for.
  if (
    c.authModeIsValid &&
    c.authMode === 'dev' &&
    !isLoopbackHost(c.bindHost) &&
    !c.allowInsecureAuth
  ) {
    problems.push(
      `AUTH_MODE=dev on a non-loopback bind (${c.bindHost}) requires no sign-in, so every ` +
        'visitor drives the agent as a shared principal with all authorization gates open. Set ' +
        'AUTH_MODE=msal, bind to 127.0.0.1, or set ALLOW_INSECURE_AUTH=true to say this is ' +
        'deliberate.',
    );
  }

  return problems;
}
