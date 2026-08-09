/**
 * Runtime configuration for the SPA.
 *
 * Resolution order: `window.__CHEMCLAW_CONFIG__` (injected by the BFF's `/config.js`, the
 * production path) -> `import.meta.env.VITE_*` (so a bare `vite dev` without the BFF still
 * boots) -> safe defaults.
 *
 * Validation is hand-rolled: this is a dozen string checks, and a schema library would be more
 * bytes than the rest of this module.
 */

export type AuthMode = 'dev' | 'msal';

export interface RuntimeConfig {
  authMode: AuthMode;
  entraTenantId: string;
  entraClientId: string;
  apiScope: string;
  apiBase: string;
  appVersion: string;
}

declare global {
  interface Window {
    __CHEMCLAW_CONFIG__?: Partial<RuntimeConfig>;
  }
}

/**
 * Whether the BFF's `/config.js` actually executed.
 *
 * This is the distinction the whole fail-closed story rests on, and it is NOT the same question as
 * "is any field set". `runtimeConfig.ts` always emits `authMode` explicitly, so in a BFF-served
 * deployment this object is always present and always says which mode was configured. Its
 * *absence* therefore means the script did not run — a 404 after a bad deploy, a blocked request,
 * a proxy serving an empty body — and not "the operator chose dev".
 *
 * Telling those apart is the entire fix. `authMode` used to be resolved with a trailing `: 'dev'`,
 * so a missing config script silently selected the provider that sends no `Authorization` header
 * at all, reported nothing beyond a chip in the header, and — because `configProblems` only
 * validated the `msal` branch — could not produce the config screen that exists for exactly this.
 */
const configScriptRan = (): boolean =>
  typeof window !== 'undefined' && window.__CHEMCLAW_CONFIG__ !== undefined;

const fromWindow = (): Partial<RuntimeConfig> =>
  typeof window === 'undefined' ? {} : (window.__CHEMCLAW_CONFIG__ ?? {});

/** A config source before validation: `authMode` may still be a value that names no mode. */
type ConfigSource = Omit<Partial<RuntimeConfig>, 'authMode'> & {
  authMode?: AuthMode | 'invalid';
};

const fromVite = (): ConfigSource => {
  const env = import.meta.env ?? {};
  return {
    authMode: parseAuthMode(env.VITE_AUTH_MODE),
    entraTenantId: env.VITE_ENTRA_TENANT_ID,
    entraClientId: env.VITE_ENTRA_CLIENT_ID,
    apiScope: env.VITE_API_SCOPE,
    apiBase: env.VITE_API_BASE,
  };
};

/**
 * `'dev'`/`'msal'` if the value names a mode, `undefined` if it is absent, `'invalid'` if it is
 * neither — a typo must not resolve to a mode, least of all the unauthenticated one.
 */
function parseAuthMode(raw: unknown): AuthMode | 'invalid' | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (raw === 'dev' || raw === 'msal') return raw;
  return 'invalid';
}

const pick = (...values: (string | undefined)[]): string => {
  for (const value of values) if (value && value.trim()) return value.trim();
  return '';
};

/** Why `authMode` ended up where it did, so `configProblems` can explain a failure precisely. */
export type AuthModeSource = 'runtime-config' | 'build-env' | 'dev-build-default' | 'unresolved';

export interface ResolvedRuntimeConfig extends RuntimeConfig {
  readonly authModeSource: AuthModeSource;
  /** Set when a config source named a mode that is not `dev` or `msal`. */
  readonly invalidAuthMode: string | null;
}

/**
 * Resolve the runtime config, failing **closed** when auth mode cannot be established.
 *
 * An unresolved mode becomes `'msal'` with empty tenant/client/scope, which `configProblems`
 * then reports — so `App` renders the configuration screen and no request is ever made. Choosing
 * `'msal'` rather than a new sentinel is deliberate: the safe fallback has to be a mode that
 * *cannot* accidentally work, and an MSAL config with nothing filled in is exactly that.
 *
 * A **development** build keeps the old convenience: `vite dev` with no BFF has no `/config.js`,
 * and requiring one there would break the documented bare-Vite workflow for no security gain,
 * since a dev server is not a deployment. `import.meta.env.DEV` is a build-time constant, so this
 * branch is eliminated from a production bundle entirely rather than being an env check a
 * misconfigured deployment could flip.
 *
 * Note this does NOT try to make `devAuth` unreachable in a production *bundle*: `start.sh` builds
 * the client with `vite build` and legitimately runs it with `AUTH_MODE=dev`, so a production
 * bundle serving dev auth is a supported deployment. The hazard was never "a prod bundle can do
 * dev auth" — it was "a prod bundle *silently falls back* to dev auth", which is what the
 * `runtime-config`/`unresolved` split above closes.
 */
function resolve(): ResolvedRuntimeConfig {
  const w = fromWindow();
  const v = fromVite();

  const windowMode = parseAuthMode(w.authMode);
  const viteMode = v.authMode;
  const invalid =
    windowMode === 'invalid'
      ? String(w.authMode)
      : viteMode === 'invalid'
        ? String(import.meta.env?.VITE_AUTH_MODE)
        : null;

  let authMode: AuthMode;
  let authModeSource: AuthModeSource;
  if (windowMode === 'dev' || windowMode === 'msal') {
    authMode = windowMode;
    authModeSource = 'runtime-config';
  } else if (viteMode === 'dev' || viteMode === 'msal') {
    authMode = viteMode;
    authModeSource = 'build-env';
  } else if (import.meta.env?.DEV && !configScriptRan()) {
    authMode = 'dev';
    authModeSource = 'dev-build-default';
  } else {
    authMode = 'msal';
    authModeSource = 'unresolved';
  }

  return {
    authMode,
    authModeSource,
    invalidAuthMode: invalid,
    entraTenantId: pick(w.entraTenantId, v.entraTenantId),
    entraClientId: pick(w.entraClientId, v.entraClientId),
    apiScope: pick(w.apiScope, v.apiScope),
    apiBase: pick(w.apiBase, v.apiBase, '/api'),
    appVersion: pick(w.appVersion, 'dev'),
  };
}

export const config: ResolvedRuntimeConfig = resolve();

/** Exported for tests, which need to resolve against a mutated `window`/`import.meta.env`. */
export { resolve as resolveConfig };

/**
 * Problems that make the app unusable, surfaced as a hard configuration screen rather than a
 * half-working login. An MSAL build missing its tenant fails in a way that looks like a network
 * error, which is a genuinely miserable thing to debug from a screenshot.
 */
/**
 * Whether a scope string carries an actual scope name, e.g. `api://<id>/Chat.Access`.
 *
 * The test used to be `apiScope.includes('/')` — which the `//` in `api://<id>` satisfies, so the
 * bare App ID URI this check exists to catch sailed straight through it. A bare URI yields an ID
 * token whose `aud` is the SPA client id, and the backend's audience check (`api/auth.py`) then
 * rejects every request with a 401 that looks nothing like a scope misconfiguration.
 *
 * So: split off the scheme first, then require a non-empty segment after the authority.
 */
function hasScopeSegment(scope: string): boolean {
  const afterScheme = scope.includes('://') ? scope.slice(scope.indexOf('://') + 3) : scope;
  const slash = afterScheme.indexOf('/');
  return slash !== -1 && afterScheme.slice(slash + 1).trim().length > 0;
}

export function configProblems(c: ResolvedRuntimeConfig = config): string[] {
  const problems: string[] = [];

  // Reported first and in its own words: every other problem below is a *consequence* of this one
  // when it fires, and "ENTRA_TENANT_ID is not set" sends someone to check an env var that is
  // probably set correctly on a server whose /config.js simply never reached the browser.
  if (c.authModeSource === 'unresolved') {
    problems.push(
      'The runtime configuration script (/config.js) did not load, so this app cannot tell ' +
        'whether it is meant to require sign-in. It is refusing to continue rather than ' +
        'defaulting to unauthenticated access. Check that the UI server is serving /config.js.',
    );
  }
  if (c.invalidAuthMode !== null) {
    problems.push(
      `AUTH_MODE "${c.invalidAuthMode}" is not a valid mode. Expected "msal" or "dev". ` +
        'It is being treated as a configuration error rather than silently falling back.',
    );
  }

  if (c.authMode === 'msal') {
    if (!c.entraTenantId) problems.push('ENTRA_TENANT_ID is not set.');
    if (!c.entraClientId) problems.push('ENTRA_CLIENT_ID is not set (the SPA app registration).');
    if (!c.apiScope) {
      problems.push('API_SCOPE is not set (expected api://<api-client-id>/<scope>).');
    } else if (!hasScopeSegment(c.apiScope)) {
      // A bare App ID URI yields an ID token, whose `aud` is the SPA client id — which the
      // backend's audience check rejects. Worth catching before the first sign-in.
      problems.push(
        `API_SCOPE "${c.apiScope}" looks like an App ID URI rather than a scope. ` +
          'It must include the scope name, e.g. api://<api-client-id>/Chat.Access',
      );
    }
  }
  return problems;
}

export const isDevAuth = (): boolean => config.authMode === 'dev';
