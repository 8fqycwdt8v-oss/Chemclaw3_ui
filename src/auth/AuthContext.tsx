/**
 * Auth bootstrap and context.
 *
 * The provider must finish initialising before anything renders: under MSAL, the redirect
 * response arrives in the URL fragment and React's first navigation would discard it.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { createAuthProvider } from './index.ts';
import type { AuthProvider } from './types.ts';

interface AuthContextValue {
  auth: AuthProvider;
  /** Bumped on sign-in/out so consumers re-read `auth.account`, which is a getter. */
  revision: number;
  refresh: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthGate({ children }: { children: ReactNode }): React.JSX.Element {
  const [auth, setAuth] = useState<AuthProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;

    // A bounded bootstrap. `pca.initialize()` and `handleRedirectPromise()` both talk to the
    // identity provider, and neither has its own timeout — so a blocked or slow tenant left the
    // app on "Starting…" indefinitely, which is indistinguishable from a hang and gives the user
    // nothing to report.
    const timeout = setTimeout(() => {
      if (!cancelled) {
        setError(
          'Sign-in did not finish in time. The identity provider may be unreachable from this ' +
            'network. Reload to try again.',
        );
      }
    }, 20_000);

    createAuthProvider()
      .then((provider) => {
        if (cancelled) return;
        clearTimeout(timeout);
        setAuth(provider);
        // The account is exposed as a getter on the provider, which React cannot observe. Bumping
        // the revision once here is what makes the signed-in name appear after a redirect returns
        // — previously `refresh()` was called only from the Sign in button, i.e. immediately
        // BEFORE navigating away, so it could never reflect the account it was meant to show.
        setRevision((r) => r + 1);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        clearTimeout(timeout);
        setError(err instanceof Error ? err.message : 'Authentication failed.');
      });

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, []);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md rounded-lg border border-danger/40 bg-danger-soft p-5">
          <h1 className="mb-1 font-semibold text-danger">Sign-in failed</h1>
          <p className="text-sm text-ink-muted">{error}</p>
        </div>
      </div>
    );
  }

  if (!auth) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-ink-muted">Starting…</p>
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ auth, revision, refresh: () => setRevision((r) => r + 1) }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthGate>');
  return ctx;
}
