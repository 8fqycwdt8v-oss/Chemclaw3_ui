/**
 * No route element writes the URL on mount until auth has settled.
 *
 * The sign-in loop this pins: MSAL returns from `/auth/callback` to the page the sign-in started
 * on and redeems the code there only while the address bar still names that page. #126 made `/`
 * that page for a first sign-in, and `Bootstrap` at `/` pushed `/c/<new id>` before
 * `handleRedirectPromise()` had finished — so MSAL went back to `/`, Bootstrap pushed again, and a
 * real browser on kind measured 212 navigations in 4 s with the code never redeemed. The
 * end-to-end proof is `e2e/oidc-mock.spec.ts`; this is the same rule at the router, with the
 * auth promise held open by hand so "before it settles" is a state the test can sit in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import type { AuthAccount, AuthProvider } from '../src/auth/types.ts';
import { jsonError, stubFetch } from './helpers.ts';

/** The auth bootstrap, held open until a test settles it. */
const auth = vi.hoisted(() => {
  let settle: { resolve: (p: unknown) => void; reject: (e: unknown) => void } | null = null;
  return {
    next(): Promise<unknown> {
      return new Promise((resolve, reject) => {
        settle = { resolve, reject };
      });
    },
    resolve: (provider: unknown) => settle?.resolve(provider),
    reject: (error: unknown) => settle?.reject(error),
  };
});

vi.mock('../src/auth/bootstrap.ts', () => ({
  get authReady() {
    return pending;
  },
}));

let pending: Promise<unknown> = auth.next();

const { useChatStore } = await import('../src/state/chatStore.ts');
const { AuthGate } = await import('../src/auth/AuthContext.tsx');
const { AppRoutes } = await import('../src/routes.tsx');

const visited: string[] = [];

function Recorder(): null {
  const { pathname } = useLocation();
  if (visited[visited.length - 1] !== pathname) visited.push(pathname);
  return null;
}

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Recorder />
      <AuthGate>
        <Routes>
          <Route path="*" element={<AppRoutes />} />
        </Routes>
      </AuthGate>
    </MemoryRouter>,
  );

const ALICE: AuthAccount = { id: 'oid-alice', username: 'alice@x', name: 'Alice', roles: [] };

const msal = (account: AuthAccount | null, login = vi.fn(async () => {})): AuthProvider => ({
  mode: 'msal',
  account,
  getAccessToken: async () => 'token',
  login,
  logout: async () => {},
  handleUnauthorized: async () => false,
});

/** Let the settled promise and the effects it triggers run. */
const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });

let restore: (() => void) | null = null;

beforeEach(() => {
  cleanup();
  restore = stubFetch(() => jsonError(404, 'not found')).restore;
  visited.length = 0;
  pending = auth.next();
  useChatStore.setState({
    conversations: {},
    order: [],
    activeId: null,
    drafts: {},
    composerLock: false,
    banner: null,
    jobFeed: [],
    streaming: null,
  });
});

afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

describe('before auth has settled', () => {
  it('leaves `/` alone and mints nothing, then lands on a conversation once it has', async () => {
    renderAt('/');
    await flush();

    // The loop's first step was this navigation. Nothing moves and nothing is created while
    // MSAL may still be comparing the address bar with the start page.
    expect(visited).toEqual(['/']);
    expect(useChatStore.getState().order).toEqual([]);

    auth.resolve(msal(ALICE));
    await flush();

    const [landed] = useChatStore.getState().order;
    expect(landed).toBeTruthy();
    expect(visited).toEqual(['/', `/c/${landed}`]);
  });

  it('does not adopt an /open/ link, or leave it, until auth has settled', async () => {
    const sessionId = 'd'.repeat(32);
    renderAt(`/open/${sessionId}`);
    await flush();

    expect(visited).toEqual([`/open/${sessionId}`]);
    expect(useChatStore.getState().order).toEqual([]);

    auth.resolve(msal(ALICE));
    await flush();

    const adopted = Object.values(useChatStore.getState().conversations).find(
      (c) => c.sessionId === sessionId,
    );
    expect(adopted).toBeTruthy();
    expect(visited).toEqual([`/open/${sessionId}`, `/c/${adopted?.id}`]);
  });

  it('holds the catch-all redirect too', async () => {
    renderAt('/no-such-page');
    await flush();
    expect(visited).toEqual(['/no-such-page']);

    auth.resolve(msal(ALICE));
    await flush();
    expect(visited.slice(0, 2)).toEqual(['/no-such-page', '/']);
  });

  it('lets go when auth fails, rather than spinning on `/` for ever', async () => {
    renderAt('/');
    await flush();
    expect(visited).toEqual(['/']);

    auth.reject(new Error('Sign-in failed at the authority.'));
    await flush();

    // Into the shell, which is where the failure's banner and its "sign in again" live.
    expect(visited).toHaveLength(2);
    expect(visited[1]).toMatch(/^\/c\//);
  });
});

describe('a signed-out visitor on an /open/ link (#132)', () => {
  it('is sent to sign in from the link itself, before anything is adopted', async () => {
    const sessionId = 'e'.repeat(32);
    const login = vi.fn(async () => {});
    renderAt(`/open/${sessionId}`);
    auth.resolve(msal(null, login));
    await flush();

    // From here, so `signInStartPage` returns them to this same `/open/` link once signed in.
    expect(login).toHaveBeenCalledTimes(1);
    expect(visited).toEqual([`/open/${sessionId}`]);
    // Nothing in the anonymous slot: the conversation is adopted in their own once they are back.
    expect(useChatStore.getState().order).toEqual([]);
    expect(screen.getByText('Signing in to open the conversation…')).toBeTruthy();
  });

  it('says so, and offers to try again, when the sign-in cannot start', async () => {
    const sessionId = 'a'.repeat(32);
    const login = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(
        new Error('interaction_in_progress: Interaction is currently in progress.'),
      )
      .mockResolvedValueOnce(undefined);
    renderAt(`/open/${sessionId}`);
    auth.resolve(msal(null, login));
    await flush();

    // Not a spinner for ever: the failure, in its own words, and a way out.
    expect(login).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert').textContent).toMatch(/interaction_in_progress/);
    expect(screen.queryByText('Signing in to open the conversation…')).toBeNull();
    expect(visited).toEqual([`/open/${sessionId}`]);
    expect(useChatStore.getState().order).toEqual([]);

    await act(async () => {
      screen.getByRole('button', { name: 'Try again' }).click();
    });
    await flush();

    expect(login).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Signing in to open the conversation…')).toBeTruthy();
  });
});
