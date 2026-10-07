/**
 * Runtime configuration for the SPA: `window.__CHEMCLAW_CONFIG__` (from the BFF's `/config.js`),
 * else `import.meta.env.VITE_*` (bare `vite dev`), else defaults. Hand-validated: `RuntimeConfig`
 * is the only declaration, read once at boot (see `docs/dependencies.md`).
 */

import type { LogLevel } from './lib/logger.ts';
import { MAX_MESSAGE_CHARS, isUsableMessageCap } from '../shared/events.ts';
import { DEFAULT_DOCS_BASE_URL } from '../shared/sandbox.ts';
import { SHARED_POLL_MS, isUsablePollInterval } from '../shared/sharedPoll.ts';

export type AuthMode = 'dev' | 'msal';

export interface RuntimeConfig {
  authMode: AuthMode;
  entraTenantId: string;
  /**
   * The MSAL authority URL; empty means Entra's public cloud for `entraTenantId` (`msalAuthority`
   * in `src/auth/msalAuth.ts`).
   */
  entraAuthority: string;
  entraClientId: string;
  apiScope: string;
  apiBase: string;
  appVersion: string;
  /**
   * Create the backend session while the user types (one round trip on send). Runtime-switchable
   * because each typed-into conversation holds a live-session slot.
   */
  warmSessions: boolean;
  /**
   * App roles that may take privileged actions (the backend's `CHEMCLAW_ENTRA_PRIVILEGED_ROLES`),
   * used only to hide controls; the service enforces. Empty under MSAL offers them to nobody;
   * irrelevant under dev auth.
   */
  reviewerRoles: string[];
  /** How much this browser logs (`src/lib/logger.ts`); `?debug=1` raises one browser. */
  logLevel: LogLevel;
  /**
   * The service's message cap in characters (deployment-tuned); falls back to `MAX_MESSAGE_CHARS`.
   */
  maxMessageChars: number;
  /**
   * Polling interval for an open shared conversation's line (`src/state/sharedSync.ts`), in ms;
   * invalid values keep the default from `shared/sharedPoll.ts`.
   */
  sharedPollMs: number;
  /**
   * The HTML sandbox origin, or `''`. Artefact HTML runs only in an opaque-origin frame from this
   * different origin; empty or equal to the page's origin shows escaped source (`HtmlView`).
   */
  sandboxOrigin: string;
  /**
   * The origin the app is meant to be reached at, or `''`; `HtmlView` compares it with
   * `window.location.origin` and shows the source when they differ.
   */
  appOrigin: string;
  /**
   * Whether artefact scripts run when shown (`HTML_SCRIPTS_DEFAULT`). Absent (no BFF) reads as off.
   */
  htmlScriptsDefault: boolean;
  /** Where the README is read from (`DOCS_BASE_URL`), e.g. an internal mirror. */
  docsBaseUrl: string;
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
    entraAuthority: env.VITE_ENTRA_AUTHORITY,
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
    entraAuthority: pick(w.entraAuthority, v.entraAuthority),
    entraClientId: pick(w.entraClientId, v.entraClientId),
    apiScope: pick(w.apiScope, v.apiScope),
    apiBase: pick(w.apiBase, v.apiBase, '/api'),
    appVersion: pick(w.appVersion, 'dev'),
    warmSessions: w.warmSessions !== false,
    reviewerRoles: Array.isArray(w.reviewerRoles) ? w.reviewerRoles.map(String) : [],
    logLevel: asLevel(w.logLevel) ?? 'info',
    // Only a usable cap (shared predicate with the BFF) displaces the default.
    maxMessageChars: isUsableMessageCap(w.maxMessageChars) ? w.maxMessageChars : MAX_MESSAGE_CHARS,
    sharedPollMs: isUsablePollInterval(w.sharedPollMs) ? w.sharedPollMs : SHARED_POLL_MS,
    sandboxOrigin: pick(w.sandboxOrigin),
    appOrigin: pick(w.appOrigin),
    htmlScriptsDefault: w.htmlScriptsDefault === true,
    docsBaseUrl: pick(w.docsBaseUrl, DEFAULT_DOCS_BASE_URL),
  };
}

export const config: RuntimeConfig = resolve();

/**
 * Problems that make the app unusable, shown as a configuration screen rather than a half-working
 * login.
 */
export function configProblems(c: RuntimeConfig = config): string[] {
  const problems: string[] = [];
  if (c.authMode === 'msal') {
    if (!c.entraTenantId) problems.push('ENTRA_TENANT_ID is not set.');
    if (!c.entraClientId) problems.push('ENTRA_CLIENT_ID is not set (the SPA app registration).');
    // The BFF refuses this at boot; repeated here for a bare `vite dev`, where nothing else would
    // catch it before MSAL throws `authority_uri_insecure` from inside its constructor.
    if (c.entraAuthority && !c.entraAuthority.startsWith('https://')) {
      problems.push(`ENTRA_AUTHORITY "${c.entraAuthority}" is not https, which MSAL refuses.`);
    }
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
