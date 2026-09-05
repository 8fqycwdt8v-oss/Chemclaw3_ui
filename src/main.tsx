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
//
// **The whole package, all seven subsets, deliberately.** A review asked for the latin subsets
// only, on the measurement that the build emits 302.67 kB of woff2 while a browser rendering
// English fetches 88.65 kB of it. Both halves of that are true and the conclusion does not
// follow: the 214 kB nobody fetches is *emitted*, not *downloaded*. `unicode-range` is what makes
// that so, and `src/index.css` already writes down why it matters here — "the Greek subset — μ, α,
// β, Δ, and the rest of a chemistry answer — downloads only when a glyph in it is actually used".
// So this is a build-artefact size, not a page weight, and the one part of it that *was* a page
// weight is fixed where it belongs (`vite.config.ts` no longer inlines a font into the
// render-blocking CSS).
//
// Narrowing it anyway would cost more than it buys, and the cost is specific rather than
// squeamish. `@fontsource-variable` ships no per-subset stylesheet — `index.css`, `wght.css`,
// `standard.css` and `opsz.css` each declare all seven faces — so "import only latin" means
// hand-writing the `@font-face` rules, which duplicates a package's own generated output,
// silently drifts from it when a subset's `unicode-range` changes upstream, and puts the
// consequence on a chemistry answer: guess one subset wrong and a Δ or an α renders in a fallback
// typeface mid-sentence, which is the failure `index.css` names by name.
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
