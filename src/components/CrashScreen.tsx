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
  // Two clicks rather than a dialog. This is destructive and irreversible, so it needs a
  // deliberate second act — and importing `ConfirmDialog` would put Radix, a portal and a focus
  // trap inside the fallback for a throw, which is the one place nothing may be able to fail.
  const [armed, setArmed] = useState(false);
  const [at] = useState(() => new Date());
  const reference = logger.correlationId();

  /**
   * Clear this browser's stored state and reload — the escape hatch this screen used to point at
   * and could not reach.
   *
   * The text here said *"use 'Reset app' in the sidebar"*, and that control lives inside the tree
   * this component has just replaced: the root boundary swaps the whole app, sidebar included, for
   * this screen. So the one documented recovery from a poisoned persisted state was reachable only
   * by reloading — which, when the poisoned state is what throws, renders this screen again. A
   * boot loop with its own way out printed on it and no way to take it. `chatStorage.getItem`
   * closes the *unparseable* half (a corrupt JSON read is a clean first run); what reaches here is
   * state that parses into a shape a renderer chokes on, which a version rollback produces on its
   * own.
   *
   * Written against `localStorage` directly rather than through `forgetLocalHistory`, deliberately
   * and for this file's stated reason: it renders above the router, the auth gate and the tooltip
   * provider, because anything it depends on could be the thing that threw. A reset that imports
   * the store cannot clear a store that failed to load.
   *
   * `sessionStorage` is left alone: MSAL's tokens live there, and signing the chemist out is not
   * what "my conversation list is broken" asks for.
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
