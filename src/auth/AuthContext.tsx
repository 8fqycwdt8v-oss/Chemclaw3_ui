/**
 * Auth bootstrap and context.
 *
 * The shell renders immediately against a placeholder provider and swaps in the real one when it
 * resolves. URL-writing route elements wait for `settled` (`src/routes.tsx`), so none navigates
 * before the session is known: a conversation created for want of one belongs in the signed-in
 * person's slot, not the anonymous one. `ready` gates anything that calls the API (send, upload,
 * session list, transcript, job streams); everything else must not wait.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { authReady } from './bootstrap.ts';
import { pendingAuth } from './pendingAuth.ts';
import { hydrateChatForAccount } from '../state/chatStore.ts';
import { hydrateExhibitPaneForAccount } from '../state/exhibitPane.ts';
import { config } from '../env.ts';
import type { AuthProvider } from './types.ts';

interface AuthContextValue {
  auth: AuthProvider;
  /** False until the real provider has replaced the placeholder. */
  ready: boolean;
  /** Why signing in did not complete, shown with a way to try again; `null` otherwise. */
  failure: string | null;
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
  const [failure, setFailure] = useState<string | null>(null);

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
        // Consumers are told to re-read the account rather than relying on a value comparison.
        setRevision((r) => r + 1);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Kept here, not in the chat store's banner: opening a conversation clears that, and this
        // is the one message the person must not lose. Not a full-screen takeover either — with
        // the composer disabled nothing harmful is reachable.
        setFailure(err instanceof Error ? err.message : 'Authentication failed.');
        setSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AuthContext.Provider
      value={{
        auth,
        ready,
        settled,
        failure,
        revision,
        refresh: () => setRevision((r) => r + 1),
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

/**
 * Whether this caller may cancel a durable job or take another privileged action. A UI hint, not
 * enforcement: the service decides and will 403 regardless.
 *
 * Dev mode (`entra_required` off) returns true for everyone, as the service does; signed in, an
 * empty `reviewerRoles` returns false for everyone, matching the service's fail-closed posture.
 */
export function useIsReviewer(): boolean {
  const { auth, revision } = useAuth();
  // `revision` is not unused: this has to re-read the account on sign-in rather than memoising
  // against a provider object whose identity never changes.
  void revision;
  if (auth.mode === 'dev') return true;
  const held = new Set(auth.account?.roles ?? []);
  return config.reviewerRoles.some((role) => held.has(role));
}
