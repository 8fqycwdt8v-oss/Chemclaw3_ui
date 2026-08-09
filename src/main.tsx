import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthGate } from './auth/AuthContext.tsx';
import { ConfigGate } from './ConfigGate.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { App } from './App.tsx';
import { clearPersisted } from './state/chatStore.ts';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

/**
 * Break a crash loop caused by stored state.
 *
 * A root boundary alone does not help when the blob itself is what crashes the app: "Reload"
 * rehydrates the same state and crashes again, and the user has no way out that does not involve
 * devtools. So repeated crashes in a short window clear the persisted state before the next mount.
 *
 * Counted in sessionStorage rather than in memory, because a reload is exactly what resets memory.
 *
 * `noteCrash` is called from `componentDidCatch`, NOT from the fallback's render body. React
 * double-invokes render under StrictMode and may discard and replay it under concurrent rendering,
 * so counting there turned a single crash into two and wiped storage on the first failure — while
 * telling the user it had happened twice. `componentDidCatch` runs once per caught error.
 */
const CRASH_KEY = 'chemclaw.crashes';
const CRASH_WINDOW_MS = 10_000;
/** Crashes needed inside the window before the stored state is treated as the cause. */
const CRASH_LIMIT = 2;

function noteCrash(): number {
  try {
    const now = Date.now();
    const raw = sessionStorage.getItem(CRASH_KEY);
    const prior = raw ? (JSON.parse(raw) as { at: number; count: number }) : null;
    const inWindow = prior !== null && now - prior.at < CRASH_WINDOW_MS;
    // `at` is the FIRST crash of the window, not the latest. Refreshing it on every count let the
    // window slide indefinitely, so a slow drip of crashes accumulated without ever expiring.
    const at = inWindow ? prior.at : now;
    const count = inWindow ? prior.count + 1 : 1;
    sessionStorage.setItem(CRASH_KEY, JSON.stringify({ at, count }));
    return count;
  } catch {
    return 1;
  }
}

/**
 * Discard the stored conversations and reload.
 *
 * Wiping and reloading rather than wiping in place, because the in-memory store still holds the
 * state that just crashed — and the persist middleware writes on the next `set`, so anything that
 * mounts afterwards puts the poisoned blob straight back. `location.reload()` runs before that can
 * happen.
 */
function wipeAndReload(): void {
  clearPersisted();
  window.location.reload();
}

function RootFallback({
  error,
  reset,
  wiped,
}: {
  error: Error;
  reset: () => void;
  wiped: boolean;
}): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-lg rounded-lg border border-danger/40 bg-danger-soft p-5">
        <h1 className="mb-2 font-semibold text-danger">Something broke while rendering</h1>
        <p className="text-sm">
          {wiped
            ? 'This has happened repeatedly, so your saved conversations are the most likely cause. Clearing them and reloading is the way out.'
            : 'The page can usually recover. If it keeps happening, clearing saved conversations is the next step.'}
        </p>
        <pre className="mt-3 max-h-32 overflow-auto rounded bg-surface-sunken p-2 font-mono text-xs">
          {error.message}
        </pre>
        <div className="mt-3 flex gap-2">
          {!wiped && (
            <button
              type="button"
              onClick={reset}
              className="rounded border border-border-subtle bg-surface-raised px-3 py-1 text-sm"
            >
              Try again
            </button>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded border border-border-subtle bg-surface-raised px-3 py-1 text-sm"
          >
            Reload
          </button>
          <button
            type="button"
            onClick={wipeAndReload}
            className="rounded border border-danger/40 bg-danger-soft px-3 py-1 text-sm text-danger"
          >
            Clear saved conversations and reload
          </button>
        </div>
      </div>
    </div>
  );
}

/** Tracks whether this boot has crashed often enough to blame the stored state. */
let crashesThisBoot = 0;

// ConfigGate outside AuthGate: a broken configuration must stop the app *before* an auth provider
// is chosen, not after. See `ConfigGate`'s docstring.
createRoot(container).render(
  <StrictMode>
    <ErrorBoundary
      onError={() => {
        crashesThisBoot = noteCrash();
      }}
      fallback={(error, reset) => (
        <RootFallback error={error} reset={reset} wiped={crashesThisBoot >= CRASH_LIMIT} />
      )}
    >
      <ConfigGate>
        <AuthGate>
          <App />
        </AuthGate>
      </ConfigGate>
    </ErrorBoundary>
  </StrictMode>,
);
