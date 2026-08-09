/**
 * Header: service health, auth state, and the error banner.
 *
 * `/readyz` is called once and deliberately not treated as blocking. It builds the agent lazily on
 * first call, so the very first request after a cold start is slow — showing "warming up" is
 * honest, whereas gating the UI on it would look like a hang.
 */

import { useEffect, useState } from 'react';
import { config } from '../env.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { useChatStore } from '../state/chatStore.ts';
import { resetSession } from '../state/sendMessage.ts';

type Health = 'checking' | 'ok' | 'down';

export function TopBar(): React.JSX.Element {
  const { auth, refresh } = useAuth();
  const [health, setHealth] = useState<Health>('checking');
  const banner = useChatStore((s) => s.banner);
  const activeId = useChatStore((s) => s.activeId);

  useEffect(() => {
    let cancelled = false;
    const check = async (): Promise<void> => {
      const ok = await api_health();
      if (!cancelled) setHealth(ok ? 'ok' : 'down');
    };
    void check();
    const timer = setInterval(() => void check(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const account = auth.account;

  return (
    <header className="border-b border-border-subtle bg-surface-raised">
      <div className="flex items-center gap-3 px-4 py-2">
        <span className="font-semibold">Chemclaw</span>

        <span
          className="flex items-center gap-1.5 text-xs text-ink-muted"
          title={`Chemclaw service: ${health}`}
        >
          <span
            className={
              health === 'ok'
                ? 'text-ok-ink'
                : health === 'down'
                  ? 'text-danger-ink'
                  : 'text-ink-muted'
            }
          >
            ●
          </span>
          {health === 'ok' ? 'connected' : health === 'down' ? 'unreachable' : 'checking'}
        </span>

        {auth.mode === 'dev' && (
          <span
            className="rounded border border-warn/40 bg-warn-soft px-1.5 py-0.5 text-xs text-warn-ink"
            title="CHEMCLAW_ENTRA_REQUIRED is off: requests are attributed to a shared dev principal"
          >
            dev auth — no sign-in
          </span>
        )}

        <div className="ml-auto flex items-center gap-3 text-xs text-ink-muted">
          <span title={`build ${config.appVersion}`}>{config.appVersion}</span>
          {auth.mode === 'msal' &&
            (account ? (
              <>
                <span title={account.username}>{account.name}</span>
                <button
                  type="button"
                  onClick={() => void auth.logout()}
                  className="underline underline-offset-2 hover:text-ink"
                >
                  Sign out
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  void auth.login();
                  refresh();
                }}
                className="rounded bg-brand px-2.5 py-1 text-brand-fg"
              >
                Sign in
              </button>
            ))}
        </div>
      </div>

      {banner && (
        <div className="flex items-center gap-3 border-t border-border-subtle bg-danger-soft px-4 py-1.5">
          <p className="text-sm text-danger-ink">{banner.text}</p>
          {banner.action === 'reset' && activeId && (
            <button
              type="button"
              onClick={() => void resetSession(activeId, auth)}
              className="rounded border border-danger/40 px-2 py-0.5 text-xs text-danger-ink"
            >
              Start a fresh session
            </button>
          )}
          {banner.action === 'reauth' && (
            <button
              type="button"
              onClick={() => void auth.login()}
              className="rounded border border-danger/40 px-2 py-0.5 text-xs text-danger-ink"
            >
              Sign in again
            </button>
          )}
          <button
            type="button"
            onClick={() => useChatStore.getState().setBanner(null)}
            className="ml-auto text-xs text-ink-muted"
          >
            Dismiss
          </button>
        </div>
      )}
    </header>
  );
}

/** Kept local so the health poll cannot accidentally acquire a token on every tick. */
async function api_health(): Promise<boolean> {
  try {
    const res = await fetch(`${config.apiBase}/healthz`, { cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}
