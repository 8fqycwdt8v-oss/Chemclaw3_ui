/**
 * The screen a chemist screenshots: error, build version, correlation id, time, and a way to copy
 * the browser's log ring buffer (`src/lib/logger.ts`).
 *
 * Dependency-light and context-free: it renders above the router, auth gate and tooltip provider,
 * any of which could be what threw.
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
  // Two clicks rather than a dialog. This is destructive and irreversible, so it needs a
  // deliberate second act — and importing `ConfirmDialog` would put Radix, a portal and a focus
  // trap inside the fallback for a throw, which is the one place nothing may be able to fail.
  const [armed, setArmed] = useState(false);
  const [at] = useState(() => new Date());
  const reference = logger.correlationId();

  /**
   * Clear this browser's stored state and reload: the recovery from persisted state that parses but
   * crashes a renderer (e.g. after a version rollback). The sidebar's reset is unreachable here,
   * since this screen replaces the app.
   *
   * Uses `localStorage` directly rather than the store, which may be what failed. `sessionStorage`
   * (MSAL tokens) is left alone so the chemist stays signed in.
   */
  const forget = (): void => {
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key?.startsWith('chemclaw3.')) keys.push(key);
      }
      for (const key of keys) localStorage.removeItem(key);
    } catch {
      // Storage denied. Nothing was persisted either, so the reload is still the right next step.
    }
    window.location.reload();
  };

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
          Reloading usually clears this. If it does not, the stored conversations in this browser
          are the likely cause — clearing them below does not touch the conversations on the server,
          which can be reopened from the list afterwards.
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={copy}>
            {state === 'copied' ? 'Diagnostics copied' : 'Copy diagnostics'}
          </Button>
          <Button
            variant="outline-destructive"
            size="sm"
            onClick={armed ? forget : () => setArmed(true)}
          >
            {armed ? 'Clear them — this cannot be undone' : 'Clear stored conversations'}
          </Button>
        </div>

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
