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
 */
const CRASH_KEY = 'chemclaw.crashes';
const CRASH_WINDOW_MS = 10_000;

function noteCrash(): number {
  try {
    const now = Date.now();
    const raw = sessionStorage.getItem(CRASH_KEY);
    const prior = raw ? (JSON.parse(raw) as { at: number; count: number }) : null;
    const count = prior && now - prior.at < CRASH_WINDOW_MS ? prior.count + 1 : 1;
    sessionStorage.setItem(CRASH_KEY, JSON.stringify({ at: now, count }));
    return count;
  } catch {
    return 1;
  }
}

function RootFallback({ error, reset }: { error: Error; reset: () => void }): React.JSX.Element {
  const wiped = noteCrash() >= 2;
  if (wiped) clearPersisted();
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-lg rounded-lg border border-danger/40 bg-danger-soft p-5">
        <h1 className="mb-2 font-semibold text-danger">Something broke while rendering</h1>
        <p className="text-sm">
          {wiped
            ? 'This happened twice in a row, so your saved conversations have been cleared — they were the most likely cause. Reload to start fresh.'
            : 'The page can usually recover. If it keeps happening, clearing saved conversations is the next step.'}
        </p>
        <pre className="mt-3 max-h-32 overflow-auto rounded bg-surface-sunken p-2 font-mono text-xs">
          {error.message}
        </pre>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={reset}
            className="rounded border border-border-subtle bg-surface-raised px-3 py-1 text-sm"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded border border-border-subtle bg-surface-raised px-3 py-1 text-sm"
          >
            Reload
          </button>
          <button
            type="button"
            onClick={() => {
              clearPersisted();
              window.location.reload();
            }}
            className="rounded border border-danger/40 bg-danger-soft px-3 py-1 text-sm text-danger"
          >
            Clear saved conversations and reload
          </button>
        </div>
      </div>
    </div>
  );
}

// ConfigGate outside AuthGate: a broken configuration must stop the app *before* an auth provider
// is chosen, not after. See `ConfigGate`'s docstring.
createRoot(container).render(
  <StrictMode>
    <ErrorBoundary fallback={(error, reset) => <RootFallback error={error} reset={reset} />}>
      <ConfigGate>
        <AuthGate>
          <App />
        </AuthGate>
      </ConfigGate>
    </ErrorBoundary>
  </StrictMode>,
);
