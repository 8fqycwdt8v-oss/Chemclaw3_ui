/**
 * Auth bootstrap and context.
 *
 * The shell renders immediately against a placeholder provider and swaps in the real one when it
 * resolves. No route may write the URL before `handleRedirectPromise()` finishes: MSAL redeems the
 * code only if the address bar still names the page sign-in started on, otherwise it navigates back
 * and retries, looping. So URL-writing route elements wait for `settled` (`src/routes.tsx`);
 * `e2e/oidc-mock.spec.ts` covers it. `ready` gates anything needing a token (send, upload, session
 * list, transcript, job streams); everything else must not wait.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { authReady } from './bootstrap.ts';
import { pendingAuth } from './pendingAuth.ts';
import { useChatStore, hydrateChatForAccount } from '../state/chatStore.ts';
import { hydrateExhibitPaneForAccount } from '../state/exhibitPane.ts';
import { config } from '../env.ts';
import type { AuthProvider } from './types.ts';

interface AuthContextValue {
  auth: AuthProvider;
  /** False until the real provider has replaced the placeholder. */
  ready: boolean;
  /**
   * True once authentication finished either way (resolved or failed). Until then nothing may write
   * the URL. Gating on `ready` alone would leave a failed sign-in on a spinner with no banner.
   */
  settled: boolean;
  /** Bumped on sign-in/out so consumers re-read `auth.account`, which is a getter. */
  revision: number;
  refresh: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthGate({ children }: { children: ReactNode }): React.JSX.Element {
  const [auth, setAuth] = useState<AuthProvider>(pendingAuth);
  const [ready, setReady] = useState(false);
  const [settled, setSettled] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    authReady
      .then((provider) => {
        if (cancelled) return;
        // Identity is known: hydrate history from this account's slot (the store defers hydration
        // via `skipHydration` for this call).
        hydrateChatForAccount(provider.account?.id);
        // The artefact pane's width is the reader's too, keyed the same way and for the same reason.
        hydrateExhibitPaneForAccount(provider.account?.id);
        setAuth(provider);
        setReady(true);
        setSettled(true);
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
        setSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AuthContext.Provider
      value={{ auth, ready, settled, revision, refresh: () => setRevision((r) => r + 1) }}
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
 * Whether this caller may cancel a durable job or take another privileged action. A UI hint, not
 * enforcement: the service decides and will 403 regardless.
 *
 * Dev mode (`entra_required` off) returns true for everyone, as the service does; under MSAL an
 * empty `reviewerRoles` returns false for everyone, matching the service's fail-closed posture.
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
