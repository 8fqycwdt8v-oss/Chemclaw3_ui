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

const fromWindow = (): Partial<RuntimeConfig> =>
  typeof window === 'undefined' ? {} : (window.__CHEMCLAW_CONFIG__ ?? {});

const fromVite = (): Partial<RuntimeConfig> => {
  const env = import.meta.env ?? {};
  return {
    authMode: env.VITE_AUTH_MODE === 'msal' ? 'msal' : undefined,
    entraTenantId: env.VITE_ENTRA_TENANT_ID,
    entraClientId: env.VITE_ENTRA_CLIENT_ID,
    apiScope: env.VITE_API_SCOPE,
    apiBase: env.VITE_API_BASE,
  };
};

const pick = (...values: (string | undefined)[]): string => {
  for (const value of values) if (value && value.trim()) return value.trim();
  return '';
};

function resolve(): RuntimeConfig {
  const w = fromWindow();
  const v = fromVite();
  return {
    authMode: w.authMode === 'msal' || v.authMode === 'msal' ? 'msal' : 'dev',
    entraTenantId: pick(w.entraTenantId, v.entraTenantId),
    entraClientId: pick(w.entraClientId, v.entraClientId),
    apiScope: pick(w.apiScope, v.apiScope),
    apiBase: pick(w.apiBase, v.apiBase, '/api'),
    appVersion: pick(w.appVersion, 'dev'),
  };
}

export const config: RuntimeConfig = resolve();

/**
 * Problems that make the app unusable, surfaced as a hard configuration screen rather than a
 * half-working login. An MSAL build missing its tenant fails in a way that looks like a network
 * error, which is a genuinely miserable thing to debug from a screenshot.
 */
export function configProblems(c: RuntimeConfig = config): string[] {
  const problems: string[] = [];
  if (c.authMode === 'msal') {
    if (!c.entraTenantId) problems.push('ENTRA_TENANT_ID is not set.');
    if (!c.entraClientId) problems.push('ENTRA_CLIENT_ID is not set (the SPA app registration).');
    if (!c.apiScope) {
      problems.push('API_SCOPE is not set (expected api://<api-client-id>/<scope>).');
    } else if (!c.apiScope.includes('/')) {
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
