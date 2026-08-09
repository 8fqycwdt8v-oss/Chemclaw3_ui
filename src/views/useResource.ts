/**
 * Load a JSON resource for a workbench view, with an explicit reload.
 *
 * Four states, and keeping them apart is the whole reason this exists rather than a bare
 * `useState` + `useEffect` per view. "Loading", "loaded and empty" and "failed to load" render
 * identically if a view collapses them — and on these surfaces they are opposite answers. An
 * empty review queue means nobody is waiting on you; a failed read of the review queue means you
 * do not know whether anybody is. The same holds for the jobs list.
 *
 * `load` and the auth provider are held in refs rather than being dependencies. For `load` that is
 * ergonomics — every caller passes an inline arrow, and a dependency on it would refetch every
 * render. For `auth` it is correctness: the token getter is called *inside* the fetch, so the ref
 * always yields the current provider, while depending on the context object's identity would make
 * a refetch happen whenever that object was replaced. Nothing about a new provider object means
 * this resource changed, and a view whose data reloads on an unrelated re-render is a request
 * amplifier — a mistake that is invisible until it is a rate limit.
 */

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext.tsx';
import type { TokenGetter } from '../api/client.ts';

export interface Resource<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  /** Re-run `load`. Keeps the previous `data` on screen while it runs, so a refresh does not
   *  blank a list the reader was mid-way through. */
  reload: () => void;
}

export function useResource<T>(
  load: (getToken: TokenGetter) => Promise<T>,
  deps: readonly unknown[],
): Resource<T> {
  const { auth } = useAuth();
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const loadRef = useRef(load);
  loadRef.current = load;
  const authRef = useRef(auth);
  authRef.current = auth;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const result = await loadRef.current(() => authRef.current.getAccessToken());
        // The await crossed a render boundary; a response for a resource the view has since
        // moved off must not overwrite the one now on screen.
        if (cancelled) return;
        setData(result);
        setError(undefined);
      } catch (err) {
        if (!cancelled) setError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, ...deps]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}

/** The message to show for a failed load. `ApiError` already carries the service's own sentence
 *  where there was one, so this only has to cover the non-`Error` case. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
