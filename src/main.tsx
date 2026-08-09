import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthGate } from './auth/AuthContext.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { App } from './App.tsx';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary
      fallback={(error) => (
        <div className="flex h-full items-center justify-center p-8">
          <div className="border-danger/40 bg-danger-soft max-w-md rounded-lg border p-5">
            <h1 className="text-danger-ink mb-1 font-semibold">Something broke</h1>
            <p className="text-ink-muted text-sm">{error.message}</p>
            <p className="text-ink-muted mt-3 text-xs">
              Reloading usually clears this. If it does not, use “Reset app” in the sidebar — your
              conversations are stored locally and a corrupt one can be cleared without losing the
              server-side session.
            </p>
          </div>
        </div>
      )}
    >
      <AuthGate>
        <App />
      </AuthGate>
    </ErrorBoundary>
  </StrictMode>,
);
