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
import { useChatStore, hydrateChatForAccount } from '../state/chatStore.ts';
import { config } from '../env.ts';
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
        // Identity is now known, so load persisted history from THIS account's slot — not before,
        // and not from the global key that used to serve one chemist's transcript to the next on a
        // shared workstation. The store deferred its own hydration (`skipHydration`) for exactly
        // this call.
        hydrateChatForAccount(provider.account?.id);
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

/**
 * Whether this caller may decide a knowledge proposal or cancel a durable job.
 *
 * **This is not enforcement and must never be treated as any.** The service decides, and it will
 * 403 whatever this returns. What it buys is that a chemist without the role is not offered a
 * button that fails — learning your own permissions from an error message is a bad way to learn
 * them, and on a proposal decision it is worse, because the reader has already formed a judgement
 * they now cannot record.
 *
 * The dev branch mirrors the service exactly: with `entra_required` off it has no real roles and
 * `_is_reviewer` returns true for everyone, so hiding the controls here would hide a capability
 * the service is offering. Under MSAL, an empty `reviewerRoles` yields false for everyone — which
 * is also the service's posture, since a deployment that enables identity and names no privileged
 * role fails closed. A queue nobody can review is a misconfiguration to notice, not to paper over.
 */
export function useIsReviewer(): boolean {
  const { auth, revision } = useAuth();
  // `revision` is not unused: `account` is a getter on the MSAL provider, so this has to re-read
  // it on sign-in rather than memoising against a value that never changes identity.
  void revision;
  if (auth.mode === 'dev') return true;
  const held = new Set(auth.account?.roles ?? []);
  return config.reviewerRoles.some((role) => held.has(role));
}
