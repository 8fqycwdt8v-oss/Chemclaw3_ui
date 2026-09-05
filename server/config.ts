/**
 * BFF configuration, read once from the environment at boot.
 *
 * Everything the browser needs at runtime is served from here via `/config.js`, so a single
 * container image can be deployed to any tenant without a rebuild (Vite inlines `import.meta.env`
 * at BUILD time, which is exactly what we are working around).
 */

import { MAX_MESSAGE_CHARS, isUsableMessageCap } from '../shared/events.ts';

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

/**
 * `MAX_MESSAGE_CHARS` as given, resolved beside a validity flag — the same pair as
 * `rawAuthMode`/`authModeIsValid` above, for the same reason.
 *
 * This used to be `Math.max(1, Math.floor(num(...)))` inline in `cfg`, and clamping *up* is the
 * destructive reading of a bad value: `0` means "refuse every message", not "use the default", and
 * a deployment that wrote it (the "0 means unlimited" convention, or a Helm `| default 0`) got a
 * one-character composer with no error anywhere. Worse, the clamp ran at the one layer that hid
 * the value from `src/env.ts`, whose guard against a zero cap can only ever see what crosses
 * `/config.js` — `1` passes it. The backend refuses the same value rather than clamping it
 * (`service_max_message_chars: Field(default=100_000, gt=0)`), and this is that posture on this
 * side of the wire: the resolved value is never a cap nobody can send through, and the refusal is
 * `validateConfig`'s.
 *
 * Whitespace is "unset", matching `str()` and `bool()` — `num()` does not trim, which is how `" "`
 * used to parse as 0 and clamp to 1.
 */
const rawMaxMessageChars = str('MAX_MESSAGE_CHARS');
const parsedMaxMessageChars = rawMaxMessageChars ? Number(rawMaxMessageChars) : MAX_MESSAGE_CHARS;
const maxMessageCharsIsValid = isUsableMessageCap(parsedMaxMessageChars);
const maxMessageChars = maxMessageCharsIsValid ? parsedMaxMessageChars : MAX_MESSAGE_CHARS;

/** Read once, because both `cfg.allowFraming` and the CSP built below have to agree. */
const allowFraming = bool('ALLOW_FRAMING', false);

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
function buildCsp(mode: AuthMode, allowFraming: boolean): string {
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
    // Framing is its own opt-in (`ALLOW_FRAMING`), not a consequence of the auth mode.
    //
    // It used to be `mode === 'dev' ? ['*'] : ["'none'"]`, which dropped this control — and the
    // `X-Frame-Options` header with it — for every dev-mode deployment, because ONE of them
    // (the Replit preview) needs an iframe. A dev-mode UI requires no sign-in and opens every
    // authorization gate, so it is the deployment that can least afford to be clickjacked.
    'frame-ancestors': allowFraming ? ['*'] : ["'none'"],
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
  /** Opt-in to being framed by any origin — the Replit preview, and nothing else so far. */
  allowFraming: boolean;
  entraTenantId: string;
  entraClientId: string;
  apiScope: string;
  appVersion: string;
  sseHeartbeatMs: number;
  upstreamConnectTimeoutMs: number;
  /**
   * How long the upstream may take to begin ANSWERING before the request is abandoned.
   *
   * Distinct from `upstreamConnectTimeoutMs`, which covers an upstream that never accepts, and
   * from `requestTimeoutMs`, which covers a client that never finishes sending. This is the one
   * that was missing, and its absence was the only unrecoverable failure on this path — see the
   * comment at its use in `server/proxy.ts`. `0` disables it and restores that.
   */
  upstreamHeadersTimeoutMs: number;
  /** How long a client may take to *send* a request before it is disconnected. */
  requestTimeoutMs: number;
  /**
   * How long a client may take to send the request HEADERS. The tighter half of the pair above.
   *
   * Node refuses a server whose `headersTimeout` exceeds its `requestTimeout`, so the value used
   * is clamped to it — see `createBffServer`.
   */
  headersTimeoutMs: number;
  /** Client connections this process will hold at once, whatever is on them. */
  maxConnections: number;
  /** How long `/readyz` fails before the listening socket is closed on SIGTERM. */
  shutdownDrainMs: number;
  /** Upstream keep-alive sockets this process will hold at once. */
  maxUpstreamSockets: number;
  /** Largest request body forwarded on an ordinary route. */
  maxBodyBytes: number;
  /** Largest request body forwarded on the attachment upload route. */
  maxUploadBytes: number;
  /** Batches one IP may POST to `/api/client-events` per minute before it is 429'd. The route is
   *  unauthenticated by design (it reports pre-sign-in failures), so this is its only bound on
   *  rate. */
  clientEventsRatePerMin: number;
  warmSessions: boolean;
  reviewerRoles: string[];
  /** The service's `CHEMCLAW_SERVICE_MAX_MESSAGE_CHARS`, told to this process rather than guessed. */
  maxMessageChars: number;
  /** The raw `MAX_MESSAGE_CHARS` as given, so a value that is not a cap can be named in the
   *  refusal rather than guessed at. */
  rawMaxMessageChars: string;
  maxMessageCharsIsValid: boolean;
  csp: string;
  logLevel: string;
  /** How much the BROWSER records, served through `/config.js`. Separate from `logLevel`, which
   *  is this process's own verbosity: turning the pod's logs up is not the same decision as
   *  turning every chemist's browser up. */
  clientLogLevel: string;
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
  // The backend's message cap, which is a *setting* there and was a compile-time constant here:
  // a site that raised `CHEMCLAW_SERVICE_MAX_MESSAGE_CHARS` got a composer still refusing at the
  // old default, and one that lowered it got a composer inviting a message the service rejects
  // with a 422 after the whole body has been uploaded. Same rule as `REVIEWER_ROLES` above — the
  // value is the backend's and there is no route that publishes it, so it is told to this process
  // per deployment. The shared constant is the fallback, so an unset variable — or one that is not
  // a usable cap, which `validateConfig` refuses — keeps today's behaviour exactly.
  maxMessageChars,
  rawMaxMessageChars,
  maxMessageCharsIsValid,
  sseHeartbeatMs: num('SSE_HEARTBEAT_MS', 15_000),
  upstreamConnectTimeoutMs: num('UPSTREAM_CONNECT_TIMEOUT_MS', 10_000),
  // Deliberately generous rather than tight. It bounds time-to-first-response-*header*, and the
  // slowest legitimate case here is a route the backend answers after real work (a protocol
  // generation, a durable launch) — not a turn, whose headers arrive at once and whose body is the
  // slow part. What matters is that a hung backend now recycles the socket pool on its own instead
  // of holding it until a human notices; a deployment that knows its backend can tighten this.
  upstreamHeadersTimeoutMs: num('UPSTREAM_HEADERS_TIMEOUT_MS', 120_000),
  // Time to RECEIVE a request, not to answer one, so this bounds nothing about a 600 s turn or a
  // silent job stream — both of those are *responses*. It used to be 0 (disabled), and the cost
  // was measured: 129 unauthenticated one-byte POSTs each claimed one of the upstream agent's
  // keep-alive sockets and never released it, which took the whole /api surface offline until the
  // attacker let go — with no credential, and with no recovery short of the attacker letting go.
  //
  // The default is 130 s rather than something tighter because this bounds the whole request, body
  // included, and the largest legitimate one here is a 32 MB attachment from a bench laptop on
  // hotel wifi. The *header* phase is bounded much more tightly, on its own knob below.
  //
  // This used to be stated as "130 s because Node refuses `headersTimeout > requestTimeout` and
  // `headersTimeout` is pinned just above the 120 s keep-alive". That was a real constraint on a
  // belief that is no longer true of this runtime — see `headersTimeoutMs`.
  requestTimeoutMs: num('REQUEST_TIMEOUT_MS', 130_000),
  // Time to receive the request HEADERS, and it was 125 s "just above the LB idle timeout".
  //
  // That reason describes a Node that stopped existing before 14.11: `headersTimeout` used to run
  // from the moment the SOCKET was accepted, so a value under the fronting keep-alive really did
  // kill the second request on a reused connection. It runs from the first byte of the request
  // now. Measured on this runtime (v22.22.2) with `headersTimeout: 500`: a keep-alive connection
  // left idle for 1,500 ms — three times the bound — served its second request normally, in
  // 1,510 ms end to end; a connection dribbling one header byte every 200 ms was answered 408 and
  // closed at 510 ms. The bound applies to the header phase and to nothing else.
  //
  // So the only real constraint is `headersTimeout <= requestTimeout`, and the number can be what
  // it should have been: long enough for any header block a real client sends in one segment,
  // short enough that a socket held open by a request that never arrives costs 30 s rather than
  // 125 s. It bounds the header phase only — a 600 s turn is a *response* and a 32 MB upload is a
  // *body*, and neither is affected.
  headersTimeoutMs: num('HEADERS_TIMEOUT_MS', 30_000),
  // Client connections held at once. Nothing bounded this, so the pod's worst-case file
  // descriptor and per-socket buffer use was whatever a caller decided to open.
  //
  // Be precise about what it buys, because the finding that asked for it overstated the case:
  // running out of descriptors at accept() is NOT a crash on this runtime. Measured with the
  // server process at `ulimit -n 96` and 300 connections arriving from another process, it
  // emitted no `error` on the server, raised no exception, and stayed listening — the surplus is
  // dropped silently. What this adds is a ceiling this process *chose*, at which it sheds, rather
  // than an unknown one the kernel enforces; 1024 is twice the upstream socket pool, so every
  // proxied request the pool can carry has a connection plus as many again for static assets and
  // probes.
  //
  // The cost is stated rather than hidden: a shed connection is destroyed without a response, so
  // a client over the ceiling reads a reset rather than a 503. There is no way to answer one
  // politely at this layer — the connection is refused before any request exists to answer.
  maxConnections: num('MAX_CONNECTIONS', 1_024),
  // How long `/readyz` answers 503 before the listening socket closes on SIGTERM. One
  // Kubernetes readiness period (its `periodSeconds` default is 10 s), so at least one probe
  // observes the refusal and takes this pod out of rotation before it stops accepting. See the
  // shutdown handler in `server/index.ts` for what it was measured against.
  shutdownDrainMs: num('SHUTDOWN_DRAIN_MS', 10_000),
  // The other half of that measurement: the pool was 128 and the outage threshold was 129. Raised
  // and made configurable so a legitimate burst of concurrent turns is not sharing a ceiling with
  // whatever is holding sockets open.
  maxUpstreamSockets: num('MAX_UPSTREAM_SOCKETS', 512),
  // The backend caps a message at 100k characters — but that is a Pydantic validator, which runs
  // after FastAPI has read and buffered the whole body. The BFF is the only thing in front of it,
  // so it is the only place a body can be refused before it is paid for. 2 MB leaves room for the
  // largest legitimate JSON here (a 100k-character message with structures attached to it).
  maxBodyBytes: num('MAX_BODY_BYTES', 2 * 1024 * 1024),
  // Attachments stream through the same pipe and are legitimately much larger.
  maxUploadBytes: num('MAX_UPLOAD_BYTES', 32 * 1024 * 1024),
  clientEventsRatePerMin: Math.max(1, Math.floor(num('CLIENT_EVENTS_RATE_PER_MIN', 60))),
  csp: buildCsp(authMode, allowFraming),
  logLevel: str('LOG_LEVEL', 'info'),
  // Defaults to `info` rather than to this process's own level: the two are independent knobs and
  // an operator debugging the BFF has not asked every open tab to start reporting.
  clientLogLevel: str('CLIENT_LOG_LEVEL', 'info'),
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
    // A path prefix on the upstream is silently discarded, so refuse it rather than serve it.
    //
    // Nothing in this process ever reads `pathname`: `server/proxy.ts` and `server/ready.ts` both
    // take `protocol`, `hostname` and `port` and then build the upstream path from the route
    // table, which starts at the gateway root. So `CHEMCLAW_API_URL=https://gw.example/chemclaw` —
    // the ordinary shape for a service behind a shared ingress — boots clean, reports ready, and
    // requests `/jobs` from a gateway that serves it at `/chemclaw/jobs`. Every `/api` route 404s
    // and the one thing that would explain it, the configured address, looks right in the startup
    // line.
    //
    // Refused rather than honoured, in the posture this function already takes for `AUTH_MODE` and
    // `MAX_MESSAGE_CHARS`: honouring it means threading a prefix through two modules and a route
    // table for a deployment that can put the prefix in its ingress instead, and a half-honoured
    // prefix is the same silent 404 with more places to look for it.
    //
    // Only the path. A query string, a fragment or userinfo on this value is dropped just as
    // silently and is not refused here — nothing produces one, and a refusal nobody can trigger is
    // a rule nobody reads.
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
      `AUTH_MODE ${JSON.stringify(c.rawAuthMode)} is not a valid mode (expected "msal" or ` +
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
