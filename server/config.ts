/**
 * BFF configuration, read once from the environment at boot. Browser-facing values are served at
 * runtime via `/config.js`, so one image runs in any tenant (Vite would inline `import.meta.env` at
 * build time).
 */

import { readFileSync } from 'node:fs';
import { MAX_MESSAGE_CHARS, isUsableMessageCap } from '../shared/events.ts';
import { DEFAULT_DOCS_BASE_URL } from '../shared/sandbox.ts';
import { MIN_SHARED_POLL_MS, SHARED_POLL_MS, isUsablePollInterval } from '../shared/sharedPoll.ts';

export type AuthMode = 'dev' | 'bff';

export type ClientAuth = 'secret' | 'none';

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
 * The raw `AUTH_MODE`, kept so `validateConfig` can refuse a typo rather than fall back to the
 * unauthenticated mode.
 */
const rawAuthMode = str('AUTH_MODE', 'dev');

const MODES: Record<string, AuthMode> = { dev: 'dev', bff: 'bff' };

/**
 * `dev` on an unrecognised value only because `cfg` cannot throw at module scope; `validateConfig`
 * refuses to serve it.
 */
const authMode: AuthMode = MODES[rawAuthMode] ?? 'dev';
const authModeIsValid = rawAuthMode in MODES;

/**
 * `MAX_MESSAGE_CHARS` as given, plus a validity flag. A bad value (including `0`) is refused by
 * `validateConfig`, never clamped, matching the backend's `gt=0`. Whitespace is treated as unset.
 */
const rawMaxMessageChars = str('MAX_MESSAGE_CHARS');
const parsedMaxMessageChars = rawMaxMessageChars ? Number(rawMaxMessageChars) : MAX_MESSAGE_CHARS;
const maxMessageCharsIsValid = isUsableMessageCap(parsedMaxMessageChars);
const maxMessageChars = maxMessageCharsIsValid ? parsedMaxMessageChars : MAX_MESSAGE_CHARS;

/** `SHARED_POLL_MS` as given, plus a validity flag: a bad value is refused rather than clamped. */
const rawSharedPollMs = str('SHARED_POLL_MS');
const parsedSharedPollMs = rawSharedPollMs ? Number(rawSharedPollMs) : SHARED_POLL_MS;
const sharedPollMsIsValid = isUsablePollInterval(parsedSharedPollMs);
const sharedPollMs = sharedPollMsIsValid ? parsedSharedPollMs : SHARED_POLL_MS;

/** Read once, because both `cfg.allowFraming` and the CSP built below have to agree. */
const allowFraming = bool('ALLOW_FRAMING', false);

/** Loopback names, for the unauthenticated-exposure check. Mirrors the backend's `_LOOPBACK_HOSTS`. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export const isLoopbackHost = (host: string): boolean => LOOPBACK_HOSTS.has(host.trim());

/** Entra's login host: the default authority's host when only a tenant is configured. */
const ENTRA_HOST = 'https://login.microsoftonline.com';

/**
 * The authority the BFF signs users in against: `ENTRA_AUTHORITY`, or Entra's public cloud for
 * `ENTRA_TENANT_ID`. Set it for a sovereign cloud or a test tenant. A trailing slash is dropped;
 * anything else wrong is `validateConfig`'s to refuse. Discovery is read from
 * `<authority>/v2.0/.well-known/openid-configuration`.
 */
const rawEntraAuthority = str('ENTRA_AUTHORITY');

/** A hostname CSP reads as a host and nothing else: DNS labels, IPv4, or a bracketed IPv6 literal. */
const AUTHORITY_HOSTNAME =
  /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/i;
const entraAuthority =
  rawEntraAuthority.replace(/\/+$/, '') || `${ENTRA_HOST}/${str('ENTRA_TENANT_ID')}`;

/**
 * A secret from the environment, or from the file `<NAME>_FILE` names (a mounted Secret): the file
 * wins, so a mounted value cannot be shadowed by a stale variable. Unreadable files are `''`, which
 * `validateConfig` refuses where the secret is required.
 */
function secret(name: string): string {
  const file = str(`${name}_FILE`);
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch {
      return '';
    }
  }
  return str(name);
}

/**
 * A plain `http(s)://host[:port]` origin, or `''`. Used for `SANDBOX_ORIGIN`/`APP_ORIGIN`, which go
 * into CSP and the shell's script: no path, userinfo or query, and no host characters CSP reads as
 * syntax.
 */
export function plainOrigin(raw: string): string {
  if (!raw) return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (url.username || url.password || url.search || url.hash) return '';
  if (url.pathname !== '/' && url.pathname !== '') return '';
  if (!AUTHORITY_HOSTNAME.test(url.hostname)) return '';
  return url.origin;
}

/**
 * The sandbox origin (the second listener, `server/sandbox.ts`) and the app's own origin, both
 * stated because the process cannot learn its public origins. The sandbox is on only when both are
 * origins and they differ.
 */
const rawSandboxOrigin = str('SANDBOX_ORIGIN');
const rawAppOrigin = str('APP_ORIGIN');
const sandboxOrigin = plainOrigin(rawSandboxOrigin);
const appOrigin = plainOrigin(rawAppOrigin);

/**
 * Whether the sandbox runs, and the startup line's reason. Off when `ALLOW_FRAMING` is set: the
 * shell's `frame-ancestors` names `APP_ORIGIN` only and CSP checks every ancestor, so a framed app
 * cannot frame the sandbox; HTML artefacts then show as source. Exported for tests and `index.ts`.
 */
export function sandboxState(c: {
  rawSandboxOrigin: string;
  sandboxOrigin: string;
  appOrigin: string;
  allowFraming: boolean;
}): { on: boolean; reason: string } {
  if (!c.rawSandboxOrigin) {
    return { on: false, reason: 'SANDBOX_ORIGIN is unset; HTML artefacts are shown as source' };
  }
  if (!c.sandboxOrigin || !c.appOrigin || c.sandboxOrigin === c.appOrigin) {
    // `validateConfig` refuses every one of these before anything serves; said for completeness.
    return { on: false, reason: 'SANDBOX_ORIGIN/APP_ORIGIN do not name two distinct origins' };
  }
  if (c.allowFraming) {
    return {
      on: false,
      reason:
        'ALLOW_FRAMING=true: a framed app cannot frame the sandbox (its frame-ancestors names ' +
        'APP_ORIGIN only, and every ancestor is checked), so HTML artefacts are shown as source',
    };
  }
  return {
    on: true,
    reason: `SANDBOX_ORIGIN ${c.sandboxOrigin} is a separate origin from APP_ORIGIN ${c.appOrigin}`,
  };
}

const sandbox = sandboxState({ rawSandboxOrigin, sandboxOrigin, appOrigin, allowFraming });
const sandboxEnabled = sandbox.on;

/**
 * Whether an `html` artefact's script runs without a click: `on` by default (owner decision, README
 * "HTML sandbox"); `off` is the kill switch. Anything else is refused.
 */
const rawHtmlScriptsDefault = str('HTML_SCRIPTS_DEFAULT', 'on').toLowerCase();
const htmlScriptsDefaultIsValid = rawHtmlScriptsDefault === 'on' || rawHtmlScriptsDefault === 'off';

/**
 * Content-Security-Policy for the SPA. Identical in every auth mode: the browser holds no token and
 * talks only to this origin, so signing in is a top-level navigation the policy does not govern.
 */
function buildCsp(allowFraming: boolean, sandbox = ''): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // No inline scripts (`/config.js` is a real file). `wasm-unsafe-eval` permits WASM compilation
    // only. RDKit's Embind needs `'unsafe-eval'`, which is never in the document's policy — only in
    // `RDKIT_WORKER_CSP` on the worker's own script. Vite's dev server sends no CSP, so verify
    // behind the BFF (`e2e/rdkit.spec.ts`).
    'script-src': ["'self'", "'wasm-unsafe-eval'"],
    // Ketcher runs Indigo in a same-origin worker, and `worker-src` does not fall back to
    // `script-src`.
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
    // Framing is its own opt-in (`ALLOW_FRAMING`), independent of auth mode: an unauthenticated dev
    // UI can least afford clickjacking.
    'frame-ancestors': allowFraming ? ['*'] : ["'none'"],
    'object-src': ["'none'"],
  };

  // The sandbox origin, only when it is on — the one other origin this page may frame.
  if (sandbox) {
    const framed = directives['frame-src']!.filter((source) => source !== "'none'");
    directives['frame-src'] = [...framed, sandbox];
  }

  return Object.entries(directives)
    .map(([key, values]) => `${key} ${values.join(' ')}`)
    .join('; ');
}

/**
 * The RDKit worker's own policy — the only place `'unsafe-eval'` is permitted. A worker loaded from
 * a network URL runs under its own response's CSP (a `blob:` worker inherits the document's), and
 * Embind's `Function(...)` needs `'unsafe-eval'`; there is no narrower token. Everything else is
 * closed, and a worker has no DOM or token in scope.
 */
export const RDKIT_WORKER_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
  "connect-src 'self'",
  "base-uri 'none'",
].join('; ');

/**
 * The emitted RDKit worker chunk (`/assets/rdkit.worker-<hash>.js`), matched exactly so no other
 * path gets the relaxed policy.
 */
export function isRdkitWorkerScript(pathname: string): boolean {
  return /^\/assets\/rdkit\.worker-[A-Za-z0-9_-]{8,}\.js$/.test(pathname);
}

/**
 * `ENTRA_CLIENT_AUTH`: `secret` (default; the Web-platform registration's client secret) or `none`
 * (a public client, PKCE alone: a test tenant that issues no secret). Anything else is refused.
 */
const rawEntraClientAuth = str('ENTRA_CLIENT_AUTH', 'secret').toLowerCase();
const entraClientAuth: ClientAuth = rawEntraClientAuth === 'none' ? 'none' : 'secret';

/**
 * Cookies are `Secure` and `__Host-` prefixed (host-only, path `/`, no `Domain`) exactly when the
 * browser reaches the app over https. A plain-http `APP_ORIGIN` is accepted for loopback only
 * (`validateConfig`) and gets unprefixed cookies, because browsers differ on `Secure` over http.
 */
const cookieSecure = appOrigin.startsWith('https:');
const cookiePrefix = cookieSecure ? '__Host-' : '';

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
  /** Opt-in to being framed by any origin — the Replit preview, and nothing else so far. */
  allowFraming: boolean;
  entraTenantId: string;
  /** The sign-in authority, resolved: `ENTRA_AUTHORITY`, or Entra's public cloud for the tenant. */
  entraAuthority: string;
  /** The raw `ENTRA_AUTHORITY` as given — empty when unset, which is the production default. */
  rawEntraAuthority: string;
  /** The BFF's own (Web platform) app registration. Never served to the browser. */
  entraClientId: string;
  /** The registration's client secret; empty when `entraClientAuth` is `none`. Never logged. */
  entraClientSecret: string;
  /** How the BFF proves who it is at the token endpoint: `secret`, or `none` for a public client. */
  entraClientAuth: ClientAuth;
  /** The raw `ENTRA_CLIENT_AUTH` as given, so a typo is named in the refusal. */
  rawEntraClientAuth: string;
  /** `ENTRA_ISSUER`: the issuer discovery must report, when the operator wants it pinned. */
  entraIssuer: string;
  apiScope: string;
  /** Whether the end-session endpoint is offered at sign-out (`ENTRA_END_SESSION`). */
  endSessionEnabled: boolean;
  /** A session unused this long ends (`SESSION_IDLE_MINUTES`). */
  sessionIdleMs: number;
  /** A session ends this long after sign-in whatever it does (`SESSION_MAX_AGE_HOURS`). */
  sessionMaxAgeMs: number;
  /** Sessions held at once; the least recently used is dropped over it (`SESSION_MAX_SESSIONS`). */
  maxSessions: number;
  /** An access token is renewed when it has less than this left (`TOKEN_REFRESH_SKEW_SECONDS`). */
  tokenRefreshSkewMs: number;
  /** A sign-in left unfinished is forgotten after this long (`LOGIN_STATE_TTL_SECONDS`). */
  loginStateTtlMs: number;
  /** Every call to the identity provider gives up after this (`OIDC_HTTP_TIMEOUT_MS`). */
  oidcHttpTimeoutMs: number;
  /** After a failed refresh the provider is left alone this long (`TOKEN_REFRESH_BACKOFF_SECONDS`). */
  tokenRefreshBackoffMs: number;
  /**
   * The secret the sign-in cookie's key is derived from (`SESSION_KEY` or `SESSION_KEY_FILE`);
   * empty means a random key per process.
   */
  sessionKey: string;
  /** Origins besides the issuer's that discovery may point at (`ENTRA_ENDPOINTS_ORIGINS`). */
  entraEndpointOrigins: string[];
  /** The session cookie's name: `__Host-` prefixed exactly when `APP_ORIGIN` is https. */
  sessionCookieName: string;
  /** The cookie that ties a sign-in in progress to the browser that began it. */
  loginCookieName: string;
  /** Whether cookies carry `Secure` (and so the `__Host-` prefix): `APP_ORIGIN` is https. */
  cookieSecure: boolean;
  appVersion: string;
  sseHeartbeatMs: number;
  upstreamConnectTimeoutMs: number;
  /**
   * How long the upstream may take to send response headers before the request is abandoned, so a
   * hung backend frees the socket pool (see `server/proxy.ts`). `0` disables it.
   */
  upstreamHeadersTimeoutMs: number;
  /** How long a client may take to *send* a request before it is disconnected. */
  requestTimeoutMs: number;
  /**
   * How long a client may take to send request headers; clamped to `requestTimeoutMs` (Node
   * requires it).
   */
  headersTimeoutMs: number;
  /** Client connections this process will hold at once, whatever is on them. */
  maxConnections: number;
  /** How long `/readyz` fails before the listening socket is closed on SIGTERM. */
  shutdownDrainMs: number;
  /** Upstream keep-alive sockets this process will hold at once for ORDINARY (non-SSE) calls. */
  maxUpstreamSockets: number;
  /** Upstream sockets reserved for the long-lived SSE routes, in a pool of their own. */
  maxUpstreamStreamSockets: number;
  /** How long a request may wait for a free socket in its pool before it is refused with a 503. */
  upstreamQueueTimeoutMs: number;
  /** Largest request body forwarded on an ordinary route. */
  maxBodyBytes: number;
  /** Largest request body forwarded on the attachment upload route. */
  maxUploadBytes: number;
  /**
   * Batches this process accepts on `/api/client-events` per minute before 429. The route is
   * unauthenticated, so this is its only rate bound (process-wide; see `server/clientEvents.ts`).
   */
  clientEventsRatePerMin: number;
  warmSessions: boolean;
  reviewerRoles: string[];
  /** The service's `CHEMCLAW_SERVICE_MAX_MESSAGE_CHARS`, told to this process rather than guessed. */
  maxMessageChars: number;
  /** The raw `MAX_MESSAGE_CHARS` as given, so a value that is not a cap can be named in the
   *  refusal rather than guessed at. */
  rawMaxMessageChars: string;
  maxMessageCharsIsValid: boolean;
  /** How often an open shared conversation reads its session's line, in ms — served to the SPA
   *  through `/config.js`. See `shared/sharedPoll.ts`. */
  sharedPollMs: number;
  /** The raw `SHARED_POLL_MS` as given, so a refusal can quote it. */
  rawSharedPollMs: string;
  sharedPollMsIsValid: boolean;
  csp: string;
  /** `SANDBOX_ORIGIN` and `APP_ORIGIN` as given, so a refusal can quote them. */
  rawSandboxOrigin: string;
  rawAppOrigin: string;
  /** Both as plain origins, or `''` where the value is not one. See `plainOrigin`. */
  sandboxOrigin: string;
  appOrigin: string;
  /** Whether the second listener runs: both origins set, valid, and different, and the app not
   *  framable (`sandboxState`). */
  sandboxEnabled: boolean;
  /** Why the sandbox is on or off, as the startup line says it (`sandboxState`). */
  sandboxReason: string;
  /** Where the second listener binds. Its own port, and by default the app's own host. */
  sandboxPort: number;
  /** `SANDBOX_PORT` as given, so a port that is not one can be quoted in the refusal. */
  rawSandboxPort: string;
  sandboxBindHost: string;
  /** `HTML_SCRIPTS_DEFAULT`, lower-cased: `on` (the default) or `off`; anything else is refused. */
  rawHtmlScriptsDefault: string;
  htmlScriptsDefaultIsValid: boolean;
  /** Whether an `html` artefact's script runs until somebody presses "Disable scripts". */
  htmlScriptsDefault: boolean;
  logLevel: string;
  /**
   * How much the browser logs, served via `/config.js`; separate from this process's `logLevel`.
   */
  clientLogLevel: string;
  /** `DOCS_BASE_URL`: where the browser reads this repository's README (an internal mirror when
   *  air-gapped), as an absolute http(s) URL or a path on this origin. */
  docsBaseUrl: string;
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
  // Same rule, and for a control of the same kind: being framed is a decision, so it is written
  // down per deployment rather than inferred from something else.
  allowFraming,
  entraTenantId: str('ENTRA_TENANT_ID'),
  entraAuthority,
  rawEntraAuthority,
  // The BFF's own app registration (platform: Web), not the API's. The backend has no
  // `CHEMCLAW_ENTRA_CLIENT_ID`.
  entraClientId: str('ENTRA_CLIENT_ID'),
  entraClientSecret: entraClientAuth === 'secret' ? secret('ENTRA_CLIENT_SECRET') : '',
  entraClientAuth,
  rawEntraClientAuth,
  entraIssuer: str('ENTRA_ISSUER').replace(/\/+$/, ''),
  // Must be an API scope: api://<api-client-id>/<scope>. Requesting only openid/profile yields
  // an ID token whose `aud` is the BFF's client id, which the backend's audience check rejects.
  apiScope: str('API_SCOPE'),
  endSessionEnabled: bool('ENTRA_END_SESSION', true),
  // Eight working hours idle; a day absolute. The refresh token outlives both, so these — not the
  // identity provider — decide how often a chemist signs in again.
  sessionIdleMs: num('SESSION_IDLE_MINUTES', 480) * 60_000,
  sessionMaxAgeMs: num('SESSION_MAX_AGE_HOURS', 24) * 3_600_000,
  // A session is ~5 kB with its tokens, so 10k is ~50 MB: far above 200 chemists per pod, and a
  // bound on a flood of sign-ins.
  maxSessions: Math.floor(num('SESSION_MAX_SESSIONS', 10_000)),
  // Entra access tokens live 60-90 minutes; renewing two minutes early keeps a request that was
  // already authorised from reaching the backend expired.
  tokenRefreshSkewMs: num('TOKEN_REFRESH_SKEW_SECONDS', 120) * 1_000,
  loginStateTtlMs: num('LOGIN_STATE_TTL_SECONDS', 600) * 1_000,
  oidcHttpTimeoutMs: num('OIDC_HTTP_TIMEOUT_MS', 10_000),
  tokenRefreshBackoffMs: num('TOKEN_REFRESH_BACKOFF_SECONDS', 5) * 1_000,
  sessionKey: secret('SESSION_KEY'),
  entraEndpointOrigins: str('ENTRA_ENDPOINTS_ORIGINS')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  sessionCookieName: `${cookiePrefix}chemclaw_session`,
  loginCookieName: `${cookiePrefix}chemclaw_login`,
  cookieSecure,
  appVersion: str('APP_VERSION', 'dev'),
  // Pre-creating a session while the user types costs the service one live-session slot per
  // conversation typed into, sent or not. Default on; switchable without a client rebuild.
  warmSessions: bool('WARM_SESSIONS', true),
  // App roles that may decide or cancel (the backend's `CHEMCLAW_ENTRA_PRIVILEGED_ROLES`), used
  // only to hide controls that would 403. Empty offers nobody those controls.
  reviewerRoles: str('REVIEWER_ROLES')
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean),
  // Must match the backend's `CHEMCLAW_SERVICE_MAX_MESSAGE_CHARS` (no route publishes it). Unset
  // falls back to the shared default.
  maxMessageChars,
  rawMaxMessageChars,
  maxMessageCharsIsValid,
  // How soon a member sees another's turn start; the browser suite shortens it.
  sharedPollMs,
  rawSharedPollMs,
  sharedPollMsIsValid,
  sseHeartbeatMs: num('SSE_HEARTBEAT_MS', 15_000),
  upstreamConnectTimeoutMs: num('UPSTREAM_CONNECT_TIMEOUT_MS', 10_000),
  // Generous: bounds time to the first response header (a turn's headers arrive at once), so a hung
  // backend recycles sockets.
  upstreamHeadersTimeoutMs: num('UPSTREAM_HEADERS_TIMEOUT_MS', 120_000),
  // Time to receive a whole request, body included (a 32 MB upload on a slow link). Without it,
  // slow unauthenticated requests could hold every upstream socket. Does not bound responses.
  requestTimeoutMs: num('REQUEST_TIMEOUT_MS', 130_000),
  // Time to receive request headers (measured from the first byte on current Node). Only
  // constraint: `<= requestTimeout`.
  headersTimeoutMs: num('HEADERS_TIMEOUT_MS', 30_000),
  // Client connections held at once (twice the upstream pool). Over it, connections are dropped
  // without a response.
  maxConnections: num('MAX_CONNECTIONS', 1_024),
  // How long `/readyz` answers 503 after SIGTERM before the listener closes — one readiness period
  // (see `server/index.ts`).
  shutdownDrainMs: num('SHUTDOWN_DRAIN_MS', 10_000),
  // The ordinary upstream pool: short calls only (probes, panel reads, stops), so a burst ceiling.
  maxUpstreamSockets: num('MAX_UPSTREAM_SOCKETS', 512),
  // The SSE upstream pool, separate so held streams cannot starve ordinary calls. 1024 = 200
  // chemists x 4 streams + headroom. The backend's own stream cap is lower and answers 429.
  maxUpstreamStreamSockets: num('MAX_UPSTREAM_STREAM_SOCKETS', 1_024),
  // How long a request waits for a free upstream socket before a 503 (`upstream_saturated`). Node's
  // agent queue is otherwise unbounded and untimed.
  upstreamQueueTimeoutMs: num('UPSTREAM_QUEUE_TIMEOUT_MS', 10_000),
  // Bodies are refused here before the backend buffers them. 2 MB fits the largest legitimate JSON
  // (a 100k-character message with structures).
  maxBodyBytes: num('MAX_BODY_BYTES', 2 * 1024 * 1024),
  // Attachments stream through the same pipe and are legitimately much larger.
  maxUploadBytes: num('MAX_UPLOAD_BYTES', 32 * 1024 * 1024),
  // 200 chemists x 12 flushes a minute, plus 25% headroom.
  clientEventsRatePerMin: Math.max(1, Math.floor(num('CLIENT_EVENTS_RATE_PER_MIN', 3_000))),
  csp: buildCsp(allowFraming, sandboxEnabled ? sandboxOrigin : ''),
  rawSandboxOrigin,
  rawAppOrigin,
  sandboxOrigin,
  appOrigin,
  sandboxEnabled,
  sandboxReason: sandbox.reason,
  sandboxPort: num('SANDBOX_PORT', 8081),
  rawSandboxPort: str('SANDBOX_PORT'),
  rawHtmlScriptsDefault,
  htmlScriptsDefaultIsValid,
  htmlScriptsDefault: rawHtmlScriptsDefault !== 'off',
  sandboxBindHost: str('SANDBOX_BIND_HOST', str('BIND_HOST', '0.0.0.0')),
  logLevel: str('LOG_LEVEL', 'info'),
  // Defaults to `info` rather than to this process's own level: the two are independent knobs and
  // an operator debugging the BFF has not asked every open tab to start reporting.
  clientLogLevel: str('CLIENT_LOG_LEVEL', 'info'),
  docsBaseUrl: str('DOCS_BASE_URL', DEFAULT_DOCS_BASE_URL),
};

/**
 * Refuse a configuration that cannot work or is unsafe, mirroring the backend's
 * `_refuse_unauthenticated_exposure`. Returns the problems; empty means OK.
 */
export function validateConfig(c: BffConfig = cfg): string[] {
  const problems: string[] = [];

  try {
    const parsed = new URL(c.apiUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      problems.push(`CHEMCLAW_API_URL must be http(s), got ${parsed.protocol}`);
    }
    // A path on `CHEMCLAW_API_URL` would be silently ignored (the proxy uses only protocol, host
    // and port), so every route would 404. Refuse it; put prefixes in the ingress.
    else if (parsed.pathname !== '/' && parsed.pathname !== '') {
      problems.push(
        `CHEMCLAW_API_URL must name the service root, not a path under it: ${JSON.stringify(
          c.apiUrl,
        )} carries the path ${JSON.stringify(parsed.pathname)}, which this process never sends. ` +
          `Use ${JSON.stringify(parsed.origin)} and let the ingress add the prefix.`,
      );
    }
  } catch {
    problems.push(`CHEMCLAW_API_URL is not a valid URL: ${JSON.stringify(c.apiUrl)}`);
  }

  if (!c.authModeIsValid) {
    problems.push(
      c.rawAuthMode === 'msal'
        ? 'AUTH_MODE=msal no longer exists: the browser no longer holds tokens. Use AUTH_MODE=bff ' +
            '(docs/operations.md, "Token custody"), which needs a Web-platform app registration ' +
            'with a client secret (ENTRA_CLIENT_SECRET) and APP_ORIGIN.'
        : `AUTH_MODE ${JSON.stringify(c.rawAuthMode)} is not a valid mode (expected "bff" or ` +
            '"dev"). Refusing to start rather than falling back to unauthenticated access.',
    );
  }

  if (!c.maxMessageCharsIsValid) {
    problems.push(
      `MAX_MESSAGE_CHARS ${JSON.stringify(c.rawMaxMessageChars)} is not a message cap (expected a ` +
        'whole number of characters above zero, e.g. 100000). Zero is not "unlimited" here — it ' +
        'is a composer that refuses every message — so this is refused rather than clamped.',
    );
  }

  if (!c.sharedPollMsIsValid) {
    problems.push(
      `SHARED_POLL_MS ${JSON.stringify(c.rawSharedPollMs)} is not a poll interval (expected a ` +
        `whole number of milliseconds, at least ${MIN_SHARED_POLL_MS}, e.g. 5000).`,
    );
  }

  if (c.authMode === 'bff') problems.push(...bffProblems(c));

  // Dev auth on a reachable bind would let anyone drive the agent as a shared principal: refused
  // unless `ALLOW_INSECURE_AUTH`. Guarded by `authModeIsValid` so a typo yields one error.
  if (
    c.authModeIsValid &&
    c.authMode === 'dev' &&
    !isLoopbackHost(c.bindHost) &&
    !c.allowInsecureAuth
  ) {
    problems.push(
      `AUTH_MODE=dev on a non-loopback bind (${c.bindHost}) requires no sign-in, so every ` +
        'visitor drives the agent as a shared principal with all authorization gates open. Set ' +
        'AUTH_MODE=bff, bind to 127.0.0.1, or set ALLOW_INSECURE_AUTH=true to say this is ' +
        'deliberate.',
    );
  }

  problems.push(...sandboxProblems(c));

  // The docs link is rendered as an `href`, so the value must be something a link may be: an
  // http(s) URL or a path on this origin — never `javascript:` or `data:`, which a link would run.
  if (!docsBaseIsUsable(c.docsBaseUrl)) {
    problems.push(
      `DOCS_BASE_URL ${JSON.stringify(c.docsBaseUrl)} is not an http(s) URL or a path starting ` +
        'with "/". It is where the app links to its README (an internal mirror when air-gapped).',
    );
  }

  return problems;
}

/** The tenants that name no single issuer: a sign-in cannot validate a token against them. */
const MULTI_TENANT_AUTHORITIES = new Set(['common', 'organizations', 'consumers']);

/**
 * What `AUTH_MODE=bff` needs and cannot guess. Every value here is read by the BFF alone; none is
 * served to the browser.
 */
function bffProblems(c: BffConfig): string[] {
  const problems: string[] = [];
  if (!c.entraTenantId && !c.rawEntraAuthority) {
    problems.push('ENTRA_TENANT_ID (or ENTRA_AUTHORITY) is required when AUTH_MODE=bff');
  }
  if (MULTI_TENANT_AUTHORITIES.has(c.entraTenantId.toLowerCase())) {
    problems.push(
      `ENTRA_TENANT_ID ${JSON.stringify(c.entraTenantId)} names no single issuer, so an ID token ` +
        'cannot be validated against it. Use the tenant GUID.',
    );
  }
  if (!c.entraClientId) problems.push('ENTRA_CLIENT_ID is required when AUTH_MODE=bff');
  if (!c.apiScope) problems.push('API_SCOPE is required when AUTH_MODE=bff');
  else if (!c.apiScope.includes('/')) {
    // A bare App ID URI yields an ID token, whose `aud` is this client — which the backend's
    // audience check rejects. Worth catching before the first sign-in.
    problems.push(
      `API_SCOPE ${JSON.stringify(c.apiScope)} looks like an App ID URI rather than a scope. It ` +
        'must include the scope name, e.g. api://<api-client-id>/Chat.Access',
    );
  }
  if (c.rawEntraClientAuth !== 'secret' && c.rawEntraClientAuth !== 'none') {
    problems.push(
      `ENTRA_CLIENT_AUTH ${JSON.stringify(c.rawEntraClientAuth)} is not "secret" or "none".`,
    );
  } else if (c.entraClientAuth === 'secret' && !c.entraClientSecret) {
    problems.push(
      'ENTRA_CLIENT_SECRET (or ENTRA_CLIENT_SECRET_FILE) is required when AUTH_MODE=bff: the ' +
        'token exchange happens here, with a Web-platform registration. ENTRA_CLIENT_AUTH=none ' +
        'is for a tenant that issues no secret.',
    );
  }

  // The origin is the redirect URI's, the cookie's and the CSRF check's one source of truth: a
  // process that cannot learn the browser's origin from a request must be told it.
  if (!c.rawAppOrigin) {
    problems.push(
      'APP_ORIGIN is required when AUTH_MODE=bff: it is the redirect URI registered with the ' +
        'identity provider (<APP_ORIGIN>/auth/callback) and the only Origin a state-changing ' +
        'request may carry.',
    );
  } else if (c.appOrigin) {
    if (!c.appOrigin.startsWith('https:') && !isLoopbackHost(new URL(c.appOrigin).hostname)) {
      problems.push(
        `APP_ORIGIN ${JSON.stringify(c.appOrigin)} is http on a non-loopback host: the session ` +
          'cookie could not be Secure. Serve the app over https.',
      );
    }
  }

  if (c.allowFraming) {
    problems.push(
      'ALLOW_FRAMING=true is refused when AUTH_MODE=bff: a signed-in app that any origin can frame ' +
        'can be clickjacked into acting as the person.',
    );
  }
  if (c.sessionKey && c.sessionKey.length < 32) {
    problems.push('SESSION_KEY must be at least 32 characters (try `openssl rand -base64 32`).');
  }
  for (const origin of c.entraEndpointOrigins) {
    if (plainOrigin(origin) !== origin.replace(/\/+$/, '')) {
      problems.push(
        `ENTRA_ENDPOINTS_ORIGINS has ${JSON.stringify(origin)}, which is not an origin.`,
      );
    }
  }
  if (c.rawEntraAuthority) problems.push(...authorityProblems(c.rawEntraAuthority));
  if (c.entraIssuer && !/^https?:\/\//.test(c.entraIssuer)) {
    problems.push(`ENTRA_ISSUER ${JSON.stringify(c.entraIssuer)} is not a URL.`);
  }

  const positive: [string, number][] = [
    ['SESSION_IDLE_MINUTES', c.sessionIdleMs],
    ['SESSION_MAX_AGE_HOURS', c.sessionMaxAgeMs],
    ['SESSION_MAX_SESSIONS', c.maxSessions],
    ['LOGIN_STATE_TTL_SECONDS', c.loginStateTtlMs],
    ['OIDC_HTTP_TIMEOUT_MS', c.oidcHttpTimeoutMs],
  ];
  for (const [name, value] of positive) {
    if (!(value > 0)) problems.push(`${name} must be a number above zero.`);
  }
  if (!(c.tokenRefreshSkewMs >= 0))
    problems.push('TOKEN_REFRESH_SKEW_SECONDS must not be negative.');
  if (!(c.tokenRefreshBackoffMs >= 0)) {
    problems.push('TOKEN_REFRESH_BACKOFF_SECONDS must not be negative.');
  }
  return problems;
}

/**
 * The authority the BFF discovers the provider from. https, except a loopback test authority: the
 * discovery document and the token exchange carry the client secret and the user's code, so a
 * plain-http authority anywhere else is refused.
 */
function authorityProblems(raw: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return [`ENTRA_AUTHORITY is not a valid URL: ${JSON.stringify(raw)}`];
  }
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))
  ) {
    return [
      `ENTRA_AUTHORITY must be https, got ${JSON.stringify(raw)}. The client secret and the ` +
        'sign-in code travel to it. Only a loopback test authority may be plain http.',
    ];
  }
  if (parsed.pathname.split('/').some((part) => MULTI_TENANT_AUTHORITIES.has(part.toLowerCase()))) {
    return [
      `ENTRA_AUTHORITY ${JSON.stringify(raw)} names no single tenant, so an ID token cannot be ` +
        'validated against it. Use the tenant GUID.',
    ];
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) {
    return [
      `ENTRA_AUTHORITY must be a plain authority URL (scheme, host, tenant path), got ` +
        `${JSON.stringify(raw)}. Discovery paths and parameters are appended by the BFF.`,
    ];
  }
  return [];
}

/** An http(s) URL, or a path on this origin (`/docs/`, never the scheme-relative `//host`). */
function docsBaseIsUsable(base: string): boolean {
  if (base.startsWith('/')) return !base.startsWith('//');
  try {
    const url = new URL(base);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Sandbox configurations that would look configured but are not a sandbox. Unset `SANDBOX_ORIGIN`
 * is fine (HTML shows as source).
 */
function sandboxProblems(c: BffConfig): string[] {
  const problems: string[] = [];
  if (!c.htmlScriptsDefaultIsValid) {
    problems.push(
      `HTML_SCRIPTS_DEFAULT ${JSON.stringify(c.rawHtmlScriptsDefault)} is not "on" or "off". It ` +
        'decides whether agent-written script runs without a click, so a typo is refused rather ' +
        'than read as either.',
    );
  }
  if (c.rawSandboxOrigin && !c.sandboxOrigin) {
    problems.push(
      `SANDBOX_ORIGIN must be a plain http(s) origin (scheme, host, optional port — no path), got ` +
        `${JSON.stringify(c.rawSandboxOrigin)}. It is written into the app's CSP.`,
    );
  }
  if (c.rawAppOrigin && !c.appOrigin) {
    problems.push(
      `APP_ORIGIN must be a plain http(s) origin (scheme, host, optional port — no path), got ` +
        `${JSON.stringify(c.rawAppOrigin)}. It is written into the sandbox shell's CSP and script.`,
    );
  }
  // `SANDBOX_PORT` is always checked: whole digits, 1–65535 (`0` binds a random port; `num()` would
  // hide a non-number).
  if (
    (c.rawSandboxPort && !/^\d+$/.test(c.rawSandboxPort)) ||
    !Number.isInteger(c.sandboxPort) ||
    c.sandboxPort < 1 ||
    c.sandboxPort > 65_535
  ) {
    problems.push(
      `SANDBOX_PORT ${JSON.stringify(c.rawSandboxPort || String(c.sandboxPort))} is not a port ` +
        '(expected a whole number from 1 to 65535).',
    );
  }
  if (!c.sandboxOrigin) return problems;
  if (!c.rawAppOrigin) {
    problems.push(
      'APP_ORIGIN is required when SANDBOX_ORIGIN is set: the sandbox shell takes content only ' +
        'from the app origin and may be framed only by it, and this process cannot learn the ' +
        "browser's origin from a request.",
    );
  } else if (c.appOrigin && c.appOrigin === c.sandboxOrigin) {
    problems.push(
      `SANDBOX_ORIGIN must differ from APP_ORIGIN (both ${JSON.stringify(c.appOrigin)}): a frame ` +
        'on the origin that holds the sign-in is not a sandbox. Use a distinct hostname, or unset ' +
        'SANDBOX_ORIGIN to show HTML artefacts as source.',
    );
  } else if (c.appOrigin.startsWith('https:') && c.sandboxOrigin.startsWith('http:')) {
    problems.push(
      `SANDBOX_ORIGIN ${JSON.stringify(c.sandboxOrigin)} is http under an https app: the browser ` +
        'blocks the frame as mixed content. Serve the sandbox over https too.',
    );
  }
  if (c.sandboxEnabled && c.sandboxPort === c.port) {
    problems.push(
      `SANDBOX_PORT ${c.sandboxPort} is the app's own PORT. The sandbox is a second listener; give ` +
        'it a port of its own.',
    );
  }
  return problems;
}
