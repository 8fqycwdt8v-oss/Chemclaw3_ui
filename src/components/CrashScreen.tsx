/**
 * The screen a chemist screenshots.
 *
 * It printed `error.message` and nothing else, which made the screenshot — the one artefact that
 * reliably reaches whoever has to fix it — almost useless: no build, so nobody could tell which
 * version broke; no reference, so nothing joined it to the service's logs; no timestamp, so "this
 * morning" was the whole time window; and no way to hand over what the browser had recorded.
 *
 * All four are already in the process. The build version is in `config` (and already shown in the
 * account dropdown), the correlation id is whatever turn was last running, the time is the time,
 * and `src/lib/logger.ts` keeps a ring buffer for exactly this moment. This component is the
 * five lines that put them where the camera is pointing.
 *
 * Deliberately dependency-light and context-free: it renders ABOVE the router, the auth gate and
 * the tooltip provider, so anything it used from those would throw inside the fallback for a
 * throw — the one failure with nowhere left to be caught.
 */

import { useState } from 'react';
import { config } from '../env.ts';
import { diagnosticsText, logger } from '../lib/logger.ts';
import { Button } from '@/components/ui/button';

export function CrashScreen({ error }: { error: Error }): React.JSX.Element {
  // `'manual'` is not a failure state: a browser that refuses the clipboard (no permission, an
  // insecure origin, an old WebView) still has to be able to hand the text over, so it is shown
  // instead of copied rather than being reported as an error the reader cannot act on.
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const [at] = useState(() => new Date());
  const reference = logger.correlationId();

  const copy = (): void => {
    const text = diagnosticsText();
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      setState('manual');
      return;
    }
    void clipboard.writeText(text).then(
      () => setState('copied'),
      () => setState('manual'),
    );
  };

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="border-danger/40 bg-danger-soft max-w-md rounded-lg border p-5">
        <h1 className="text-danger-ink mb-1 font-semibold">Something broke</h1>
        <p className="text-ink-muted text-sm">{error.message}</p>

        <dl className="text-ink-subtle mt-3 grid grid-cols-[auto_1fr] gap-x-3 font-mono text-2xs">
          <dt>build</dt>
          <dd>{config.appVersion}</dd>
          <dt>time</dt>
          <dd>{at.toISOString()}</dd>
          <dt>reference</dt>
          {/* Empty is honest: not every crash happens during a turn, and inventing a reference
              would send whoever reads it looking for a turn that does not exist. */}
          <dd>{reference || '—'}</dd>
        </dl>

        <p className="text-ink-muted mt-3 text-xs">
          Reloading usually clears this. If it does not, use “Reset app” in the sidebar — your
          conversations are stored locally and a corrupt one can be cleared without losing the
          server-side session.
        </p>

        <Button variant="outline" size="sm" className="mt-3" onClick={copy}>
          {state === 'copied' ? 'Diagnostics copied' : 'Copy diagnostics'}
        </Button>

        {state === 'manual' && (
          <pre
            // Focusable because it scrolls: a scroll region nothing inside can focus is
            // unreachable without a pointer, which `eslint-plugin-jsx-a11y` and `axe` disagree
            // about and a named region satisfies both.
            tabIndex={0}
            role="region"
            aria-label="Diagnostics to copy"
            className="border-border-subtle mt-2 max-h-40 overflow-auto rounded border p-2 font-mono text-2xs whitespace-pre-wrap"
          >
            {diagnosticsText()}
          </pre>
        )}
      </div>
    </div>
  );
}
