/**
 * The MSAL provider — the one auth module that only ever runs in production, and the one that had
 * no test at all.
 *
 * The asymmetry this closes is worth stating: `server/config.ts`, which does nothing but decide
 * between `dev` and `msal`, carries fourteen cases — several written after an unrecognised
 * `AUTH_MODE` silently booted a deployment with no sign-in. The module that actually holds a
 * credential, constructs the authority, orders the redirect handling, and decides when to force a
 * re-auth had none. Everything below is a behaviour that only shows up against a live tenant,
 * which is exactly why it needs a test rather than a careful reading.
 *
 * `@azure/msal-browser` is mocked at the module boundary rather than driven for real: the real one
 * navigates the window and talks to login.microsoftonline.com. What is under test is *our* use of
 * it — which scopes we ask for, what we do with the redirect result, and which of its errors means
 * "redirect" rather than "throw".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Every call the provider makes into MSAL, recorded for assertion. */
const calls = {
  initialize: 0,
  handleRedirectPromise: 0,
  loginRedirect: [] as unknown[],
  acquireTokenSilent: [] as unknown[],
  acquireTokenRedirect: [] as unknown[],
  logoutRedirect: 0,
  setActiveAccount: [] as unknown[],
};

/** What the fake MSAL should do on the next call — set per test before importing the provider. */
const behaviour: {
  redirectResult: unknown;
  accounts: unknown[];
  active: unknown;
  silent: 'ok' | 'interaction-required' | 'other-error';
} = { redirectResult: null, accounts: [], active: null, silent: 'ok' };

class InteractionRequiredAuthError extends Error {}

vi.mock('@azure/msal-browser', () => ({
  InteractionRequiredAuthError,
  PublicClientApplication: class {
    constructor(public config: unknown) {}
    async initialize() {
      calls.initialize += 1;
    }
    async handleRedirectPromise() {
      calls.handleRedirectPromise += 1;
      return behaviour.redirectResult;
    }
    getActiveAccount() {
      return behaviour.active;
    }
    setActiveAccount(account: unknown) {
      calls.setActiveAccount.push(account);
      behaviour.active = account;
    }
    getAllAccounts() {
      return behaviour.accounts;
    }
    async loginRedirect(request: unknown) {
      calls.loginRedirect.push(request);
    }
    async acquireTokenSilent(request: unknown) {
      calls.acquireTokenSilent.push(request);
      if (behaviour.silent === 'interaction-required') {
        throw new InteractionRequiredAuthError('interaction_required');
      }
      if (behaviour.silent === 'other-error') throw new Error('network is down');
      return { accessToken: 'an-access-token' };
    }
    async acquireTokenRedirect(request: unknown) {
      calls.acquireTokenRedirect.push(request);
    }
    async logoutRedirect() {
      calls.logoutRedirect += 1;
    }
  },
}));

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = '99999999-8888-7777-6666-555555555555';
const SCOPE = `api://${CLIENT}/Chat.Access`;

vi.mock('../src/env.ts', () => ({
  config: {
    authMode: 'msal',
    entraTenantId: TENANT,
    entraClientId: CLIENT,
    apiScope: SCOPE,
    apiBase: '/api',
    appVersion: 'test',
    warmSessions: false,
    reviewerRoles: [],
  },
}));

const account = (over: Record<string, unknown> = {}) => ({
  homeAccountId: 'home-id',
  username: 'alice@corp.example',
  name: 'Alice Chemist',
  idTokenClaims: { oid: 'u-alice', roles: ['process-chemist'] },
  ...over,
});

beforeEach(() => {
  Object.assign(calls, {
    initialize: 0,
    handleRedirectPromise: 0,
    loginRedirect: [],
    acquireTokenSilent: [],
    acquireTokenRedirect: [],
    logoutRedirect: 0,
    setActiveAccount: [],
  });
  Object.assign(behaviour, {
    redirectResult: null,
    accounts: [],
    active: null,
    silent: 'ok',
  });
  sessionStorage.clear();
});

describe('the MSAL configuration', () => {
  it('names the SPA client and the tenant authority, and stores tokens per tab', async () => {
    const { buildMsalConfig } = await import('../src/auth/msalAuth.ts');
    const config = buildMsalConfig();

    expect(config.auth.clientId).toBe(CLIENT);
    expect(config.auth.authority).toBe(`https://login.microsoftonline.com/${TENANT}`);
    expect(config.auth.knownAuthorities).toEqual(['login.microsoftonline.com']);
    expect(config.auth.redirectUri).toBe(`${window.location.origin}/auth/callback`);
    // sessionStorage, not localStorage: the token dies with the tab, which removes a persistent
    // cross-tab exfiltration target. Asserted because it is a security decision, not a default.
    expect(config.cache?.cacheLocation).toBe('sessionStorage');
  });

  it('requests the API scope, not an OpenID scope', async () => {
    const { apiScopes } = await import('../src/auth/msalAuth.ts');
    // The most common "valid-looking token is rejected" cause: openid/profile yields an ID token
    // whose `aud` is the SPA's own client id, and the backend checks `aud == entra_audience`.
    expect(apiScopes()).toEqual([SCOPE]);
    expect(apiScopes()[0]).toContain('/');
  });
});

describe('starting up', () => {
  it('reads the redirect response before anything else can navigate over it', async () => {
    const signedIn = account();
    behaviour.redirectResult = { account: signedIn };

    const { createMsalAuth } = await import('../src/auth/msalAuth.ts');
    const auth = await createMsalAuth();

    expect(calls.initialize).toBe(1);
    expect(calls.handleRedirectPromise).toBe(1);
    expect(calls.setActiveAccount).toEqual([signedIn]);
    expect(auth.account?.id).toBe('u-alice');
  });

  it('adopts a cached account when the load is not a redirect return', async () => {
    const cached = account({ username: 'bob@corp.example' });
    behaviour.accounts = [cached];

    const { createMsalAuth } = await import('../src/auth/msalAuth.ts');
    await createMsalAuth();

    expect(calls.setActiveAccount).toEqual([cached]);
  });

  it('signs nobody in when there is no redirect result and no cached account', async () => {
    const { createMsalAuth } = await import('../src/auth/msalAuth.ts');
    const auth = await createMsalAuth();

    expect(calls.setActiveAccount).toEqual([]);
    expect(auth.account).toBeNull();
  });
});

describe('the account it reports', () => {
  it('is the token oid, which is what the backend attributes every action to', async () => {
    behaviour.redirectResult = { account: account() };
    const { createMsalAuth } = await import('../src/auth/msalAuth.ts');

    const { account: who } = await createMsalAuth();

    expect(who).toEqual({
      id: 'u-alice',
      username: 'alice@corp.example',
      name: 'Alice Chemist',
      roles: ['process-chemist'],
    });
  });

  it('falls back to the MSAL account id when the token carries no oid', async () => {
    behaviour.redirectResult = { account: account({ idTokenClaims: {} }) };
    const { createMsalAuth } = await import('../src/auth/msalAuth.ts');

    const { account: who } = await createMsalAuth();

    expect(who?.id).toBe('home-id');
    // Not `undefined`: `useIsReviewer` does a set membership on this, and an absent array would
    // throw where "this account holds no roles" is the honest answer.
    expect(who?.roles).toEqual([]);
  });
});

describe('acquiring a token', () => {
  it('returns the silently refreshed token for the active account', async () => {
    behaviour.redirectResult = { account: account() };
    const { createMsalAuth } = await import('../src/auth/msalAuth.ts');
    const auth = await createMsalAuth();

    expect(await auth.getAccessToken()).toBe('an-access-token');
    expect(calls.acquireTokenSilent).toEqual([{ account: behaviour.active, scopes: [SCOPE] }]);
  });

  it('starts a sign-in and returns null when nobody is signed in', async () => {
    const { createMsalAuth } = await import('../src/auth/msalAuth.ts');
    const auth = await createMsalAuth();

    // null means "send no Authorization header" everywhere else in this codebase, and here it
    // means "navigation is in flight, abandon this request" — the same absence, and the reason
    // the caller must be inside a try/catch or a gate either way.
    expect(await auth.getAccessToken()).toBeNull();
    expect(calls.loginRedirect).toEqual([{ scopes: [SCOPE] }]);
  });

  it('escalates to an interactive redirect exactly when MSAL says interaction is required', async () => {
    behaviour.redirectResult = { account: account() };
    behaviour.silent = 'interaction-required';
    const { createMsalAuth } = await import('../src/auth/msalAuth.ts');
    const auth = await createMsalAuth();

    expect(await auth.getAccessToken()).toBeNull();
    expect(calls.acquireTokenRedirect).toHaveLength(1);
  });

  it('rethrows any other failure instead of bouncing the user through a redirect', async () => {
    behaviour.redirectResult = { account: account() };
    behaviour.silent = 'other-error';
    const { createMsalAuth } = await import('../src/auth/msalAuth.ts');
    const auth = await createMsalAuth();

    // A network failure is not a sign-in problem. Redirecting on one would send a chemist to a
    // login page to fix an unplugged VPN, and hide the real error behind a navigation.
    await expect(auth.getAccessToken()).rejects.toThrow('network is down');
    expect(calls.acquireTokenRedirect).toHaveLength(0);
  });
});

describe('recovering from a 401', () => {
  it('forces one interactive re-auth and reports that the request is abandoned', async () => {
    behaviour.redirectResult = { account: account() };
    const { createMsalAuth } = await import('../src/auth/msalAuth.ts');
    const auth = await createMsalAuth();

    // False, not true: a redirect is under way, so there is no fresh token to retry *this*
    // request with. A `true` here would make every caller retry against a page that is unloading.
    expect(await auth.handleUnauthorized()).toBe(false);
    expect(calls.acquireTokenRedirect).toHaveLength(1);
  });

  it('signs in rather than re-acquiring when there is no account to re-auth', async () => {
    const { createMsalAuth } = await import('../src/auth/msalAuth.ts');
    const auth = await createMsalAuth();

    expect(await auth.handleUnauthorized()).toBe(false);
    expect(calls.loginRedirect).toHaveLength(1);
    expect(calls.acquireTokenRedirect).toHaveLength(0);
  });

  it('refuses a second forced re-auth inside the cooldown', async () => {
    behaviour.redirectResult = { account: account() };
    const { createMsalAuth } = await import('../src/auth/msalAuth.ts');
    const auth = await createMsalAuth();

    await auth.handleUnauthorized();
    await auth.handleUnauthorized();

    // The loop guard. A misconfigured audience or scope 401s *every* request; without this the app
    // redirects forever, which is indistinguishable from a hang and hides the actual error.
    expect(calls.acquireTokenRedirect).toHaveLength(1);
  });

  it('allows another once the cooldown has passed', async () => {
    behaviour.redirectResult = { account: account() };
    const { createMsalAuth } = await import('../src/auth/msalAuth.ts');
    const auth = await createMsalAuth();

    await auth.handleUnauthorized();
    // Reach into the recorded timestamp rather than faking the clock: the cooldown is a stored
    // instant, and moving it back is the same event as a minute passing.
    sessionStorage.setItem('chemclaw.lastReauth', String(Date.now() - 61_000));
    await auth.handleUnauthorized();

    expect(calls.acquireTokenRedirect).toHaveLength(2);
  });
});

describe('signing in and out', () => {
  it('uses a redirect rather than a popup', async () => {
    const { createMsalAuth } = await import('../src/auth/msalAuth.ts');
    const auth = await createMsalAuth();

    await auth.login();
    await auth.logout();

    // Popups are blocked by default in several enterprise browser configurations, and Conditional
    // Access / MFA / device-compliance flows render badly inside one.
    expect(calls.loginRedirect).toEqual([{ scopes: [SCOPE] }]);
    expect(calls.logoutRedirect).toBe(1);
  });

  it('takes the conversations with it', async () => {
    // MSAL's own cache is in `sessionStorage` and dies with the tab, which is right and is not
    // the whole story: every transcript is persisted separately to `localStorage`, under one
    // global key that is not partitioned by account. Sign-out removed the credential and left
    // the data the credential was protecting — on a shared analytical-development workstation,
    // the next chemist to sign in read the previous one's unpublished route out of the sidebar,
    // before any token was involved.
    const { useChatStore, flushChatPersistence, hydrateChatForAccount, chatStorageKey } =
      await import('../src/state/chatStore.ts');
    const { createMsalAuth } = await import('../src/auth/msalAuth.ts');

    // The transcript now lives in this account's own slot, keyed by its Entra object id — which is
    // the fix: the next chemist to sign in reads THEIR slot, not this one. Point the store at it
    // the way the auth bootstrap does.
    const OID = 'oid-of-the-first-chemist';
    hydrateChatForAccount(OID);
    const key = chatStorageKey(OID);

    const cid = useChatStore.getState().createConversation();
    useChatStore.getState().appendUserMessage(cid, 'the unpublished route');
    sessionStorage.setItem('chemclaw.lastReauth', String(Date.now()));
    // The disk write is throttled and may have been coalesced with an earlier test's write in
    // this same module instance; force it out before asserting on what actually persisted.
    flushChatPersistence();
    expect(localStorage.getItem(key)).toContain('the unpublished route');
    // And it is NOT under the old global key, which is what leaked between accounts.
    expect(localStorage.getItem('chemclaw3.chat.v2')).toBeNull();

    const auth = await createMsalAuth();
    await auth.logout();

    expect(localStorage.getItem(key)).toBeNull();
    expect(sessionStorage.getItem('chemclaw.lastReauth')).toBeNull();
    // And in memory too: `logoutRedirect` navigates, but a redirect that is blocked or slow must
    // not leave the previous account's transcript on screen.
    const conversations = Object.values(useChatStore.getState().conversations);
    expect(conversations.flatMap((c) => c.messages)).toEqual([]);
  });
});
