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

import type { LogLevel } from './lib/logger.ts';

export type AuthMode = 'dev' | 'msal';

export interface RuntimeConfig {
  authMode: AuthMode;
  entraTenantId: string;
  entraClientId: string;
  apiScope: string;
  apiBase: string;
  appVersion: string;
  /**
   * Create the backend session while the user is still typing, so their first message costs one
   * round-trip instead of two.
   *
   * Runtime-switchable because it changes a backend resource pattern: every conversation someone
   * types into occupies a slot in the service's live-session LRU, sent or not. If that turns out
   * to matter, this can be turned off without a client rebuild.
   */
  warmSessions: boolean;
  /**
   * App roles whose holders may decide a knowledge proposal or cancel a durable job.
   *
   * Configured rather than hardcoded because the names are a deployment's own — they mirror the
   * service's `CHEMCLAW_ENTRA_PRIVILEGED_ROLES`. Used to hide affordances, never to enforce
   * anything: the service is the only party that decides, and it will 403 regardless of what
   * this list says.
   *
   * Empty under MSAL means nobody is offered a decision, which is exactly the service's own
   * fail-closed posture. Irrelevant in dev auth, where the service opens the gate for everyone
   * and so does `useIsReviewer`.
   */
  reviewerRoles: string[];
  /**
   * How much this browser records through `src/lib/logger.ts`.
   *
   * Runtime rather than build-time for the same reason everything else here is: one image, any
   * tenant. A deployment that wants its UI quiet sets `silent`; the usual posture is `info`, and
   * `?debug=1` raises one chemist's browser to `debug` without a redeploy — which is the case
   * support is actually in when a single user is the one seeing the fault.
   */
  logLevel: LogLevel;
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

/** A level the logger will accept, or `info` — a typo must not silence the record. */
const asLevel = (value: unknown): LogLevel | undefined => {
  const known: LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug'];
  return known.find((level) => level === value);
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
    warmSessions: w.warmSessions !== false,
    reviewerRoles: Array.isArray(w.reviewerRoles) ? w.reviewerRoles.map(String) : [],
    logLevel: asLevel(w.logLevel) ?? 'info',
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
