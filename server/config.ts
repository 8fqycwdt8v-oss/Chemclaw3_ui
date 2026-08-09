/**
 * BFF configuration, read once from the environment at boot.
 *
 * Everything the browser needs at runtime is served from here via `/config.js`, so a single
 * container image can be deployed to any tenant without a rebuild (Vite inlines `import.meta.env`
 * at BUILD time, which is exactly what we are working around).
 */

/**
 * How the app authenticates, and — the part that actually differs — who holds the token.
 *
 * - `bff`      — this process completes the OIDC flow and keeps the tokens in a sealed cookie. The
 *                browser never sees a bearer token, so an XSS in the SPA cannot exfiltrate one.
 * - `msal-spa` — the previous behaviour: MSAL runs in the browser and holds tokens in
 *                `sessionStorage`, and this process forwards the `Authorization` header verbatim.
 * - `dev`      — no sign-in at all. Fail-closed: refused on a non-loopback bind without an explicit
 *                opt-out, and refused by the built bundle unless it was built to permit it.
 */
export type AuthMode = 'dev' | 'bff' | 'msal-spa';

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

/**
 * `msal` is kept as an alias and now resolves to `bff`, not to browser-MSAL.
 *
 * That is a deliberate behaviour change for existing deployments and it is the reason this alias
 * exists at all rather than being dropped: the safer custody model has to be what an unchanged
 * configuration gets. It cannot happen silently — `bff` requires a client secret and a session
 * secret that a `msal` deployment does not have, so `validateConfig` refuses to boot and names
 * `msal-spa` as the way to keep the previous flow. A loud failure at deploy time is the point.
 */
const MODES: Record<string, AuthMode> = {
  dev: 'dev',
  bff: 'bff',
  'msal-spa': 'msal-spa',
  msal: 'bff',
};
const authMode: AuthMode = MODES[rawAuthMode] ?? 'dev';
const authModeIsValid = rawAuthMode in MODES;

/** 32 characters is `openssl rand -base64 24`. Below that the seal is decorative. */
const MIN_SESSION_SECRET_LENGTH = 32;

/** Loopback names, for the unauthenticated-exposure check. Mirrors the backend's `_LOOPBACK_HOSTS`. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Entra's login host, needed in the CSP when browser-MSAL is on — see `csp` below. */
const ENTRA_HOST = 'https://login.microsoftonline.com';

/**
 * Content-Security-Policy for the SPA.
 *
 * Built conditionally on auth mode because browser-MSAL refreshes tokens silently through a hidden
 * IFRAME to login.microsoftonline.com. Copying the backend's `connect-src 'self'` verbatim
 * would break that refresh roughly an hour after login — a failure that looks like a random
 * logout and is miserable to trace back to a header.
 *
 * `bff` mode needs **none** of those relaxations, and that is a real security gain rather than an
 * incidental one. The BFF talks to Entra from the server, so the browser makes no cross-origin
 * request, loads no cross-origin frame, and submits no cross-origin form — sign-in is a plain
 * top-level navigation, which CSP does not govern. So `bff` gets the same strict policy as `dev`
 * minus the framing relaxation: no third-party origin is reachable from the page at all.
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

  if (mode === 'msal-spa') {
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
  /** Required in `bff` mode only: this is a confidential client. Never leaves the server. */
  entraClientSecret: string;
  apiScope: string;
  /** Required in `bff` mode: the key the session cookie is sealed under. Never leaves the server. */
  sessionSecret: string;
  /** How this deployment is reachable from a browser, e.g. `https://chem.example.com`. */
  publicOrigin: string;
  /** The identity provider's origin. Non-default for a sovereign cloud, or for a test. */
  entraAuthorityHost: string;
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
  // Only `bff` mode has one, and only `bff` mode can: a SPA cannot hold a secret, which is the
  // whole reason browser-MSAL uses PKCE with a public client. Moving custody to the server is what
  // makes a confidential client possible, and a confidential client is materially harder to abuse
  // with a stolen authorization code.
  entraClientSecret: str('ENTRA_CLIENT_SECRET'),
  // Must be an API scope: api://<api-client-id>/<scope>. Requesting only openid/profile yields
  // an ID token whose `aud` is the SPA client id, which the backend's audience check rejects.
  apiScope: str('API_SCOPE'),
  sessionSecret: str('SESSION_SECRET'),
  // Sovereign clouds are at login.microsoftonline.us / .partner.microsoftonline.cn, and a tenant
  // in one is unreachable at the commercial endpoint. Constrained to HTTPS below.
  entraAuthorityHost: str('ENTRA_AUTHORITY_HOST', ENTRA_HOST).replace(/\/+$/, ''),
  // Optional; `httpUtil.selfOrigin` falls back to the Host header and explains what that costs.
  // Strip a trailing slash so `${origin}/auth/callback` cannot become a double slash, which Entra
  // compares literally against the registration and rejects.
  publicOrigin: str('PUBLIC_ORIGIN').replace(/\/+$/, ''),
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
      `AUTH_MODE ${JSON.stringify(c.rawAuthMode)} is not a valid mode (expected "bff", ` +
        '"msal-spa" or "dev"). Refusing to start rather than falling back to unauthenticated ' +
        'access.',
    );
  }

  // Common to both authenticated modes: the same tenant, the same app registration, the same scope.
  if (c.authMode === 'bff' || c.authMode === 'msal-spa') {
    const mode = c.authMode;
    if (!c.entraTenantId) problems.push(`ENTRA_TENANT_ID is required when AUTH_MODE=${mode}`);
    if (!c.entraClientId) problems.push(`ENTRA_CLIENT_ID is required when AUTH_MODE=${mode}`);
    if (!c.apiScope) problems.push(`API_SCOPE is required when AUTH_MODE=${mode}`);
  }

  if (c.authMode === 'bff') {
    // Named together, with the upgrade path spelled out, because the deployment most likely to hit
    // this is an existing `AUTH_MODE=msal` one that changed nothing and now will not start. The
    // message has to be enough to decide between "adopt BFF custody" and "stay where I was".
    const upgrading = c.rawAuthMode === 'msal';
    const context = upgrading
      ? ' AUTH_MODE=msal now resolves to BFF token custody, where this server holds the tokens ' +
        'and the browser never sees one. To keep the previous browser-MSAL behaviour unchanged, ' +
        'set AUTH_MODE=msal-spa.'
      : '';
    if (!c.entraClientSecret) {
      problems.push(
        'ENTRA_CLIENT_SECRET is required when AUTH_MODE=bff — the BFF is a confidential client, ' +
          'so the app registration needs a Web platform with a client secret and ' +
          `<PUBLIC_ORIGIN>/auth/callback as a redirect URI.${context}`,
      );
    }
    if (!c.sessionSecret) {
      problems.push(
        'SESSION_SECRET is required when AUTH_MODE=bff — it is the key the session cookie is ' +
          `sealed under. Generate one with \`openssl rand -base64 48\`.${upgrading ? context : ''}`,
      );
    } else if (c.sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
      // Length, not entropy — entropy is unmeasurable from here. The floor exists to catch
      // "changeme" and a copied placeholder, both of which make the whole seal decorative.
      problems.push(
        `SESSION_SECRET is too short (${c.sessionSecret.length} characters, minimum ` +
          `${MIN_SESSION_SECRET_LENGTH}). Anything a person could type is guessable, and a ` +
          'guessable key means anyone can forge a session for any user.',
      );
    }
    // An unset PUBLIC_ORIGIN is deliberately NOT fatal — `selfOrigin` falls back to the Host
    // header, and both users of that value have an independent check behind them (see its
    // docstring). It is warned about at boot instead, so local development is not blocked. A
    // malformed one is fatal, because it produces a redirect URI Entra will simply reject.
    // The client secret and the code both cross this connection, so plain HTTP to anywhere but
    // this machine would put them on the wire in the clear. Loopback is exempt so the flow can be
    // exercised against a mock provider in a test.
    if (!/^https:\/\//.test(c.entraAuthorityHost)) {
      const host = (() => {
        try {
          return new URL(c.entraAuthorityHost).hostname;
        } catch {
          return '';
        }
      })();
      if (!isLoopbackHost(host)) {
        problems.push(
          'ENTRA_AUTHORITY_HOST must be https — the client secret and the authorization code are ' +
            `both sent to it. Got ${JSON.stringify(c.entraAuthorityHost)}.`,
        );
      }
    }

    if (c.publicOrigin && !/^https?:\/\/[^/]+$/.test(c.publicOrigin)) {
      problems.push(
        'PUBLIC_ORIGIN must be a bare scheme+host, e.g. https://chem.example.com — got ' +
          JSON.stringify(c.publicOrigin),
      );
    }
  }

  if (c.authMode === 'dev' && !isLoopbackHost(c.bindHost) && !c.allowInsecure) {
    problems.push(
      `SECURITY: AUTH_MODE=dev but the UI binds a non-loopback interface (${c.bindHost}) — ` +
        'every visitor would drive the agent as the shared dev principal with all authorization ' +
        'gates OPEN, from any origin (dev mode also serves frame-ancestors * and no ' +
        'X-Frame-Options). Set AUTH_MODE=bff for any shared/exposed deployment, bind ' +
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
