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
    createAuthProvider()
      .then((provider) => {
        if (!cancelled) setAuth(provider);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Authentication failed.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md rounded-lg border border-danger/40 bg-danger-soft p-5">
          <h1 className="mb-1 font-semibold text-danger-ink">Sign-in failed</h1>
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
