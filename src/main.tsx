import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { AuthGate } from './auth/AuthContext.tsx';
import { CrashScreen } from './components/CrashScreen.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { logger, startClientEventSink } from './lib/logger.ts';
import { AppRoutes } from './routes.tsx';
import { Announcer } from '@/components/chem/Announcer';
import { SkipLinks } from '@/components/chem/SkipLinks';
import { TooltipProvider } from '@/components/ui/tooltip';
// Before index.css so the @font-face rules are registered by the time the token that names
// them is used. Vite rewrites these to hashed same-origin assets.
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './index.css';

/**
 * The two failures nothing in this app could see.
 *
 * `grep -rn "unhandledrejection|window.onerror" src/` returned zero hits, and the codebase leans
 * hard on `void promise` (32 sites) — including the one the composer floats for every Send. So a
 * rejection with no handler, or a throw outside React's render, was invisible to everyone but the
 * chemist watching it fail. These two listeners are the last resort under all of it; they report
 * and do not otherwise interfere, so nothing about the app's behaviour changes.
 *
 * Installed before the sink, so a failure during boot is still in the ring buffer when the sink
 * starts and is delivered with the first batch.
 */
window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason;
  logger.error('unhandled.rejection', {
    name: reason instanceof Error ? reason.name : typeof reason,
    message: reason instanceof Error ? reason.message : String(reason),
  });
});

window.addEventListener('error', (event) => {
  // `event.error` is absent for a cross-origin script error ("Script error."), which is worth
  // recording as itself rather than as an empty one.
  logger.error('unhandled.error', {
    message: event.message || 'unknown error',
    source: `${event.filename}:${event.lineno}`,
  });
});

startClientEventSink();

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary fallback={(error) => <CrashScreen error={error} />}>
      {/* Router above auth: `/auth/callback` has to be a route, and nothing about routing
          depends on being signed in. TooltipProvider above the routes rather than inside the
          shell, or it remounts on every navigation and drops its delay-group timer. */}
      <BrowserRouter>
        <TooltipProvider>
          <AuthGate>
            <SkipLinks />
            <Announcer />
            <AppRoutes />
          </AuthGate>
        </TooltipProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
