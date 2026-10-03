/**
 * BFF configuration, read once from the environment at boot.
 *
 * Everything the browser needs at runtime is served from here via `/config.js`, so a single
 * container image can be deployed to any tenant without a rebuild (Vite inlines `import.meta.env`
 * at BUILD time, which is exactly what we are working around).
 */

import { MAX_MESSAGE_CHARS, isUsableMessageCap } from '../shared/events.ts';
import { DEFAULT_DOCS_BASE_URL } from '../shared/sandbox.ts';
import { MIN_SHARED_POLL_MS, SHARED_POLL_MS, isUsablePollInterval } from '../shared/sharedPoll.ts';

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

/**
 * `SHARED_POLL_MS` as given, resolved beside a validity flag — the `MAX_MESSAGE_CHARS` pair again.
 * A value that is not an interval is refused by `validateConfig` rather than clamped, so a typo
 * cannot quietly turn every open shared conversation into a tight loop against the service.
 */
const rawSharedPollMs = str('SHARED_POLL_MS');
const parsedSharedPollMs = rawSharedPollMs ? Number(rawSharedPollMs) : SHARED_POLL_MS;
const sharedPollMsIsValid = isUsablePollInterval(parsedSharedPollMs);
const sharedPollMs = sharedPollMsIsValid ? parsedSharedPollMs : SHARED_POLL_MS;

/** Read once, because both `cfg.allowFraming` and the CSP built below have to agree. */
const allowFraming = bool('ALLOW_FRAMING', false);

/** Loopback names, for the unauthenticated-exposure check. Mirrors the backend's `_LOOPBACK_HOSTS`. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export const isLoopbackHost = (host: string): boolean => LOOPBACK_HOSTS.has(host.trim());

/** Entra's login host, needed in the CSP when MSAL is on — see `csp` below. */
const ENTRA_HOST = 'https://login.microsoftonline.com';

/**
 * The MSAL authority: `ENTRA_AUTHORITY` as given, or Entra's public cloud for `ENTRA_TENANT_ID`.
 *
 * **Unset is the production path and it is exactly what it was** — `https://login.microsoftonline.com/<tenant>`,
 * the string `src/auth/msalAuth.ts` used to hardcode — and so is the CSP built from it below;
 * `tests/csp.test.ts` pins the whole header byte for byte. Setting it is for an authority that is
 * not Entra's public cloud: a sovereign cloud (`login.microsoftonline.us`), or the mock tenant in
 * Chemclaw3_mock that the OIDC browser test signs in against (`e2e/oidc-mock.spec.ts`).
 *
 * A trailing slash is dropped so the value is the same shape as the default; anything else about
 * it is `validateConfig`'s to refuse, not this line's to repair.
 */
const rawEntraAuthority = str('ENTRA_AUTHORITY');

/** A hostname CSP reads as a host and nothing else: DNS labels, IPv4, or a bracketed IPv6 literal. */
const AUTHORITY_HOSTNAME =
  /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/i;
const entraAuthority =
  rawEntraAuthority.replace(/\/+$/, '') || `${ENTRA_HOST}/${str('ENTRA_TENANT_ID')}`;

/**
 * The origin the CSP opens for MSAL — the authority's, so a configured authority is reachable and
 * nothing else is. `ENTRA_HOST` when the value does not parse: `validateConfig` refuses to serve
 * that, and until it does the header stays the one this process has always sent.
 */
const authorityOrigin = (authority: string): string => {
  try {
    return new URL(authority).origin;
  } catch {
    return ENTRA_HOST;
  }
};

/**
 * A plain `http(s)://host[:port]` origin, or `''` for anything else.
 *
 * For `SANDBOX_ORIGIN` and `APP_ORIGIN` (wave 3). Both are written into a CSP — `frame-src` on the
 * app, `frame-ancestors` on the sandbox shell — and the second is also injected into the shell's
 * script as the one origin it takes content from. So the value must be an origin and nothing else:
 * no path (a CSP source with a path matches only that path), no userinfo, no query, and a host CSP
 * reads as a host, for `AUTHORITY_HOSTNAME`'s reason — `http://*` would admit every host.
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
 * The HTML sandbox's origin and the app's own, as given and as origins (wave 3).
 *
 * `SANDBOX_ORIGIN` is where the browser reaches this process's **second listener** — the one that
 * serves `GET /sandbox/frame` and nothing else (`server/sandbox.ts`). `APP_ORIGIN` is where the
 * browser reaches the app; the sandbox shell takes content only from it and may be framed only by
 * it. The process cannot learn either from a request — a public origin is the ingress's to choose —
 * so both are stated. The sandbox is on only when both are origins and they **differ**:
 * `validateConfig` refuses the other combinations rather than serving a sandbox that is not one.
 */
const rawSandboxOrigin = str('SANDBOX_ORIGIN');
const rawAppOrigin = str('APP_ORIGIN');
const sandboxOrigin = plainOrigin(rawSandboxOrigin);
const appOrigin = plainOrigin(rawAppOrigin);

/**
 * Whether the sandbox runs, and the sentence the startup line says about it (hardening, 2026-10-03).
 *
 * On only when both origins are origins, they differ, **and the app is not framable by anyone**
 * (`ALLOW_FRAMING`). The last is a choice, documented in README "HTML sandbox": the shell's
 * `frame-ancestors` names `APP_ORIGIN` alone, and CSP checks *every* ancestor, so inside a preview
 * host's iframe the sandbox frame is blocked by the browser and the artefact is a blank box. That
 * combination is not refused — every launcher this repository ships now sets the sandbox origins,
 * so a refusal would turn the preview opt-in into a process that cannot start — it is turned off
 * with its reason logged, and HTML artefacts are shown as escaped source, which is what a framed
 * app can honestly offer.
 *
 * Exported for the tests and for `index.ts`'s one line; `cfg` carries the result.
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
 * Whether an `html` artefact's own script runs without anybody pressing a button (contract,
 * hardening item 4). **On by default — an owner decision of 2026-10-03**, taken with the residual
 * risks written down (README "HTML sandbox"); `HTML_SCRIPTS_DEFAULT=off` is the kill switch that
 * puts back "Run scripts". Anything but `on`/`off` is refused by `validateConfig` rather than read
 * as either: a typo in a security switch must not silently pick a side.
 */
const rawHtmlScriptsDefault = str('HTML_SCRIPTS_DEFAULT', 'on').toLowerCase();
const htmlScriptsDefaultIsValid = rawHtmlScriptsDefault === 'on' || rawHtmlScriptsDefault === 'off';

/**
 * Content-Security-Policy for the SPA.
 *
 * Built conditionally on auth mode because MSAL refreshes tokens silently through a hidden
 * IFRAME to login.microsoftonline.com. Copying the backend's `connect-src 'self'` verbatim
 * would break that refresh roughly an hour after login — a failure that looks like a random
 * logout and is miserable to trace back to a header.
 */
function buildCsp(
  mode: AuthMode,
  allowFraming: boolean,
  authority: string = ENTRA_HOST,
  sandbox = '',
): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // No inline scripts: /config.js is a real same-origin file precisely so this can stay strict.
    //
    // `wasm-unsafe-eval` is what lets `WebAssembly.instantiate` run at all. It permits WASM
    // compilation and nothing else — it does NOT re-open `eval` or inline script, which is
    // exactly why the narrow token exists.
    //
    // **It is not sufficient for RDKit, and the page does not get what is.** `@rdkit/rdkit`'s
    // Embind glue builds its invokers with `Function(...)` on the ordinary path, so the toolkit
    // needs `'unsafe-eval'` — and that token is never in THIS policy, the document's. It is in
    // `RDKIT_WORKER_CSP` below, sent only on the RDKit worker's own script response, which a
    // network-served dedicated worker takes as its policy instead of the document's (measured,
    // `ISSUES.md` Issue 10). The relaxation lives on a thread with no DOM and no markup path.
    //
    // Verify against the BFF, not against Vite: the dev server serves index.html itself and never
    // sends this header, so a missing directive here fails ONLY in the container. That is how
    // Issue 10 stayed invisible; `e2e/rdkit.spec.ts` now draws a structure behind the real BFF.
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

  // The authority's ORIGIN, not its URL: CSP source expressions with a path match that path
  // only, and MSAL talks to several under the authority (discovery, token, the iframe's
  // authorize). For the default authority this is `ENTRA_HOST` itself, so the header is unchanged.
  if (mode === 'msal') {
    const origin = authorityOrigin(authority);
    directives['connect-src'] = ["'self'", origin];
    directives['frame-src'] = [origin];
    directives['form-action'] = ["'self'", origin];
  }

  // The HTML sandbox's origin, and only when it is on: the one other origin this page may frame
  // (`HtmlView`). Its own page carries its own, far stricter policy (`server/sandbox.ts`); this
  // line only lets the frame exist. Off, the header is byte-for-byte what it was.
  if (sandbox) {
    const framed = directives['frame-src']!.filter((source) => source !== "'none'");
    directives['frame-src'] = [...framed, sandbox];
  }

  return Object.entries(directives)
    .map(([key, values]) => `${key} ${values.join(' ')}`)
    .join('; ');
}

/**
 * The RDKit worker's own policy — the one place `'unsafe-eval'` is permitted, and only there.
 *
 * **Why a header on one script changes anything.** A dedicated worker loaded from a network URL
 * runs under the CSP of *its own response*, not the document's; a `blob:` or `data:` worker
 * inherits the document's. Measured in Chromium 151 (`ISSUES.md` Issue 10): under a document CSP
 * without `'unsafe-eval'`, a same-origin worker whose response carries `script-src 'self'
 * 'wasm-unsafe-eval' 'unsafe-eval'` evaluates `new Function`, the identical script served with
 * the document's policy throws `EvalError`, and so does a `blob:` worker. `ISSUES.md` used to say
 * the opposite of the network case; it was not measured then.
 *
 * **Why `'unsafe-eval'` and not only `'wasm-unsafe-eval'`.** Measured against the built worker
 * behind this BFF: with the WASM token alone the worker's load throws `EvalError` in Embind's
 * `craftInvokerFunction` and nothing is drawn; with `'unsafe-eval'` added it draws. Nothing
 * narrower exists — CSP has no token for "`Function` but not `eval`".
 *
 * Everything else is closed: no `default-src` fallback to anything, `connect-src 'self'` for the
 * `.wasm` fetch, and `script-src 'self'` so the worker can import its sibling chunks and nothing
 * from anywhere else. A worker has no DOM, so there is no markup for an injected string to become
 * and no token in scope — the page holds the bearer token and the page's policy is unchanged.
 */
export const RDKIT_WORKER_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
  "connect-src 'self'",
  "base-uri 'none'",
].join('; ');

/**
 * The emitted RDKit worker chunk, by shape — the only response `RDKIT_WORKER_CSP` is sent on.
 *
 * Vite writes it as `assets/rdkit.worker-<hash>.js` (the name `scripts/check-bundle.mjs` and
 * `e2e/worker.spec.ts` already hold it to). Anchored at both ends and to `/assets/`, so no other
 * path — a deep link, a query-carrying variant of the shell, another chunk — can pick up the
 * relaxed policy. As a subresource `<script>` the header would be ignored anyway; as a navigated
 * document it is served `text/javascript` with `nosniff`, which renders as text and runs nothing.
 */
export function isRdkitWorkerScript(pathname: string): boolean {
  return /^\/assets\/rdkit\.worker-[A-Za-z0-9_-]{8,}\.js$/.test(pathname);
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
  /** The MSAL authority, resolved: `ENTRA_AUTHORITY`, or Entra's public cloud for the tenant. */
  entraAuthority: string;
  /** The raw `ENTRA_AUTHORITY` as given — empty when unset, which is the production default. */
  rawEntraAuthority: string;
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
  /** Batches this PROCESS accepts on `/api/client-events` per minute before it 429s. The route is
   *  unauthenticated by design (it reports pre-sign-in failures), so this is its only bound on
   *  rate — and there is no per-address bucket, for the reason `server/clientEvents.ts` measured.
   *  The docstring here used to say "one IP", which was never what the code counted. */
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
  /** How much the BROWSER records, served through `/config.js`. Separate from `logLevel`, which
   *  is this process's own verbosity: turning the pod's logs up is not the same decision as
   *  turning every chemist's browser up. */
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
  // How soon a member sees somebody else's turn start, against one small GET per open shared
  // conversation per tick. The default suits a deployment; the browser suite shortens it for the
  // one page that waits on it rather than sleeping through the production cadence.
  sharedPollMs,
  rawSharedPollMs,
  sharedPollMsIsValid,
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
  //
  // This is now the ORDINARY pool only. Every call it carries is short — a health probe, a panel
  // fetch, a turn stop — so 512 is a burst ceiling rather than a residency one: 200 chemists
  // arriving at 09:00 fire one `/healthz` and a handful of panel loads each, and none of them
  // holds a socket for more than a round trip.
  maxUpstreamSockets: num('MAX_UPSTREAM_SOCKETS', 512),
  // The SSE pool, and the number that decides how many chemists a UI pod can hold.
  //
  // Measured on the shipped build against a stub upstream that holds streams open: one shared
  // pool of 512 filled at exactly 512 live streams, and with it full an ordinary
  // `GET /api/healthz` never answered at all (curl exit 28, 0 bytes) — the queue below has no
  // timeout of its own, so `POST /sessions/{id}/messages` queued behind the streams for ever.
  // Splitting the pools is what makes that impossible; this number is what decides when the
  // STREAMS themselves start queueing.
  //
  // 1024 = 200 chemists x (3 job streams + 1 turn stream) + 22% headroom, which is the
  // deployment target this repository is sized against. A pod expecting more raises it; the
  // cost is one file descriptor and one upstream TCP connection per socket, and the backend
  // must be willing to accept them (`service_max_event_streams_total` is its own, lower bound —
  // over it the service 429s, which the SPA's job-stream client already backs off from).
  maxUpstreamStreamSockets: num('MAX_UPSTREAM_STREAM_SOCKETS', 1_024),
  // How long a request may sit in `http.Agent`'s queue waiting for a socket.
  //
  // Node's agent queue is unbounded and untimed: `agent.timeout` and `request.setTimeout` both
  // bound a socket this request HAS, and a request that never gets one is bounded by neither. So
  // a saturated pool did not degrade, it stopped — every subsequent call hung until a stream
  // somewhere ended, which for a job stream means until the tab closes. A refusal is strictly
  // better than that: the SPA's stream client backs off with jitter on a non-2xx, an ordinary
  // call surfaces a banner the chemist can act on, and `upstream_saturated` in the log plus the
  // upstream-error counter make the pod's real limit visible from a scrape.
  upstreamQueueTimeoutMs: num('UPSTREAM_QUEUE_TIMEOUT_MS', 10_000),
  // The backend caps a message at 100k characters — but that is a Pydantic validator, which runs
  // after FastAPI has read and buffered the whole body. The BFF is the only thing in front of it,
  // so it is the only place a body can be refused before it is paid for. 2 MB leaves room for the
  // largest legitimate JSON here (a 100k-character message with structures attached to it).
  maxBodyBytes: num('MAX_BODY_BYTES', 2 * 1024 * 1024),
  // Attachments stream through the same pipe and are legitimately much larger.
  maxUploadBytes: num('MAX_UPLOAD_BYTES', 32 * 1024 * 1024),
  // 200 chemists x 12 flushes a minute (`src/lib/logger.ts`'s 5 s cadence) is 2,400, so the old
  // ceiling refused three of every four batches at the deployment target — thinning the browser's
  // record by 4x at exactly the moment something is wrong, and spending 40 req/s of this pod on
  // writing the refusals. 3,000 is that arithmetic plus 25% headroom. The worst case it admits is
  // 3,000 x 64 KiB ≈ 3.2 MB/s, still an order below the 31 MB/s this process was measured
  // sustaining.
  //
  // It also had NO READER until now: the limit `handleClientEvents` enforced was a module
  // constant of its own, so this knob configured nothing and a deployment that raised it changed
  // no behaviour at all.
  clientEventsRatePerMin: Math.max(1, Math.floor(num('CLIENT_EVENTS_RATE_PER_MIN', 3_000))),
  csp: buildCsp(authMode, allowFraming, entraAuthority, sandboxEnabled ? sandboxOrigin : ''),
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

  if (!c.sharedPollMsIsValid) {
    problems.push(
      `SHARED_POLL_MS ${JSON.stringify(c.rawSharedPollMs)} is not a poll interval (expected a ` +
        `whole number of milliseconds, at least ${MIN_SHARED_POLL_MS}, e.g. 5000).`,
    );
  }

  if (c.authMode === 'msal') {
    if (!c.entraTenantId) problems.push('ENTRA_TENANT_ID is required when AUTH_MODE=msal');
    if (!c.entraClientId) problems.push('ENTRA_CLIENT_ID is required when AUTH_MODE=msal');
    if (!c.apiScope) problems.push('API_SCOPE is required when AUTH_MODE=msal');
  }

  // An authority MSAL cannot use is refused here, at boot, rather than in every chemist's browser
  // — where it is a crash screen naming an MSAL error code nobody on the bench can act on.
  //
  // **https only, and there is no flag that relaxes it**, unlike `ALLOW_INSECURE_AUTH` below. That
  // flag exists because a dev-mode UI on a non-loopback bind *works* and is merely dangerous; an
  // http authority does not work at all — `@azure/msal-browser` refuses one itself
  // (`authority_uri_insecure`, `UrlString.validateAsUri` in msal-common 16, loopback included). A
  // flag would let the process start and then fail in the page. A local test authority is served
  // over https with a throwaway certificate instead: see `playwright.oidc-mock.config.ts`.
  if (c.rawEntraAuthority) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(c.rawEntraAuthority);
    } catch {
      problems.push(`ENTRA_AUTHORITY is not a valid URL: ${JSON.stringify(c.rawEntraAuthority)}`);
    }
    if (parsed && parsed.protocol !== 'https:') {
      problems.push(
        `ENTRA_AUTHORITY must be https, got ${JSON.stringify(c.rawEntraAuthority)}. MSAL.js ` +
          'refuses any other scheme (authority_uri_insecure), so this would fail at sign-in in ' +
          'every browser. Serve a local test authority over https with a throwaway certificate.',
      );
    } else if (parsed && (parsed.search || parsed.hash || parsed.username || parsed.password)) {
      problems.push(
        `ENTRA_AUTHORITY must be a plain authority URL (scheme, host, tenant path), got ` +
          `${JSON.stringify(c.rawEntraAuthority)}. MSAL appends its own paths and parameters to it.`,
      );
    } else if (parsed && !AUTHORITY_HOSTNAME.test(parsed.hostname)) {
      // The origin is written into connect-src, frame-src and form-action, and the URL parser
      // accepts host characters CSP reads as syntax: `https://*/t` would allow every https host,
      // and `https://x;frame-ancestors/t` would inject a directive.
      problems.push(
        `ENTRA_AUTHORITY must name a plain DNS host or IP address, got ` +
          `${JSON.stringify(c.rawEntraAuthority)}. Its origin is written into the CSP.`,
      );
    }
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
 * What makes a sandbox configuration not a sandbox — refused, in this function's usual posture,
 * rather than served half-working.
 *
 * Every refusal here is a deployment that would otherwise *look* configured: a frame that never
 * paints because `frame-ancestors` names an origin the app is not served from, a shell that ignores
 * every message because it was told the wrong app origin, or — worst — a "sandbox" on the app's own
 * origin, which is not one. Unset `SANDBOX_ORIGIN` is not a problem: `html` artefacts then show as
 * escaped source, and the second listener does not start.
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
  // Unconditionally, sandbox configured or not — a bad value is a typo whoever reads it, and the
  // README states the rule without a condition. Whole digits as typed *and* in range: `num()` falls back to 8081 on a non-number, so only the
  // raw value can show that `SANDBOX_PORT=abc` was asked for; and a `0` would make Node bind a
  // random port no Route points at, while 70000 throws at listen.
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
