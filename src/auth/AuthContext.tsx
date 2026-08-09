/**
 * Auth bootstrap and context.
 *
 * The shell renders immediately against a placeholder provider and swaps to the real one when it
 * resolves. Blocking the whole app on authentication was costing a full MSAL round-trip before
 * first paint, for a transcript that lives in localStorage and needs no token at all.
 *
 * What still must not happen is React navigating over MSAL's redirect fragment before
 * `handleRedirectPromise()` has read it. That is handled structurally rather than by blocking:
 * `/auth/callback` is a route whose element writes no URL, and the URL-sync effects live inside
 * the `/c/:id` element (see `src/routes.tsx`).
 *
 * `ready` is what consumers gate on. Anything that needs a token — sending, uploading, the session
 * list, the transcript read, the job streams — must wait for it. Anything that does not — theme,
 * sidebar, drafts, the unauthenticated health poll — must not.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { authReady } from './bootstrap.ts';
import { pendingAuth } from './pendingAuth.ts';
import { useChatStore } from '../state/chatStore.ts';
import type { AuthProvider } from './types.ts';

interface AuthContextValue {
  auth: AuthProvider;
  /** False until the real provider has replaced the placeholder. */
  ready: boolean;
  /** Bumped on sign-in/out so consumers re-read `auth.account`, which is a getter. */
  revision: number;
  refresh: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthGate({ children }: { children: ReactNode }): React.JSX.Element {
  const [auth, setAuth] = useState<AuthProvider>(pendingAuth);
  const [ready, setReady] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    authReady
      .then((provider) => {
        if (cancelled) return;
        setAuth(provider);
        setReady(true);
        // `account` is a getter on the MSAL provider, so consumers are told to re-read it rather
        // than relying on a value comparison.
        setRevision((r) => r + 1);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A banner, not a full-screen takeover. Blocking the app on this is exactly the behaviour
        // this change removes, and with the composer disabled nothing harmful is reachable.
        useChatStore.getState().setBanner({
          kind: 'error',
          text: err instanceof Error ? err.message : 'Authentication failed.',
          action: 'reauth',
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AuthContext.Provider
      value={{ auth, ready, revision, refresh: () => setRevision((r) => r + 1) }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthGate>');
  return ctx;
}
