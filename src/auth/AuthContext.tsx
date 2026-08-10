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
import { authReady, restartAuth } from './bootstrap.ts';
import { pendingAuth } from './pendingAuth.ts';
import { useChatStore } from '../state/chatStore.ts';
import type { AuthProvider } from './types.ts';

interface AuthContextValue {
  auth: AuthProvider;
  /** False until the real provider has replaced the placeholder. */
  ready: boolean;
  /**
   * Three states, because `ready` alone cannot tell "still resolving" from "gave up".
   *
   * When bootstrap rejected, `ready` stayed false for the life of the page and every token-gated
   * affordance — sending, uploading, the session list, the transcript read, the job streams —
   * stayed disabled behind a banner the user could dismiss, after which nothing on screen
   * explained why the app did nothing. A failure has to be distinguishable and terminal.
   */
  status: 'resolving' | 'ready' | 'failed';
  /** Bumped on sign-in/out so consumers re-read `auth.account`, which is a getter. */
  revision: number;
  refresh: () => void;
  /** Retry a failed bootstrap. No-op unless `status` is 'failed'. */
  retry: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthGate({ children }: { children: ReactNode }): React.JSX.Element {
  const [auth, setAuth] = useState<AuthProvider>(pendingAuth);
  const [status, setStatus] = useState<'resolving' | 'ready' | 'failed'>('resolving');
  const [revision, setRevision] = useState(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // The module-scope promise on the first pass, a fresh provider on an explicit retry.
    (attempt === 0 ? authReady : restartAuth())
      .then((provider) => {
        if (cancelled) return;
        setAuth(provider);
        setStatus('ready');
        // `account` is a getter on the MSAL provider, so consumers are told to re-read it rather
        // than relying on a value comparison.
        setRevision((r) => r + 1);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A banner, not a full-screen takeover. Blocking the app on this is exactly the behaviour
        // this change removes, and with the composer disabled nothing harmful is reachable.
        //
        // But it must reach a terminal state: leaving `status` on 'resolving' made a permanent
        // failure look like a boot still in progress, forever.
        setStatus('failed');
        useChatStore.getState().setBanner({
          kind: 'error',
          text: err instanceof Error ? err.message : 'Authentication failed.',
          action: 'reauth',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <AuthContext.Provider
      value={{
        auth,
        ready: status === 'ready',
        status,
        revision,
        refresh: () => setRevision((r) => r + 1),
        retry: () => {
          setStatus('resolving');
          useChatStore.getState().setBanner(null);
          setAttempt((a) => a + 1);
        },
      }}
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
