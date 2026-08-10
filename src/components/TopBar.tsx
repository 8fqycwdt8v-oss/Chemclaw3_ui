/**
 * Header: service health, auth state, and the error banner.
 *
 * `/readyz` is called once and deliberately not treated as blocking. It builds the agent lazily on
 * first call, so the very first request after a cold start is slow — showing "warming up" is
 * honest, whereas gating the UI on it would look like a hang.
 */

import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import { config } from '../env.ts';
import { cn } from '../lib/cn.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { useChatStore } from '../state/chatStore.ts';
import { resetSession } from '../state/sendMessage.ts';
import type { Banner, Conversation } from '../state/types.ts';

type Health = 'checking' | 'ok' | 'down';

/**
 * The palette for each banner kind.
 *
 * `kind` used to be read by nothing: every banner rendered in the danger tone, so a warning and an
 * informational notice both shouted like a failure — and a strip that shouts about routine news is
 * one a reader learns to skip, including on the turn it is reporting a real one.
 *
 * There is no `info` colour token and this file is not the place to mint one (`src/index.css`,
 * Tailwind v4 `@theme`): `accent` is the neutral tone the rest of the UI already uses for "this is
 * a fact, not a problem".
 *
 * Whole class strings rather than `bg-${kind}-soft`, because Tailwind v4 discovers classes by
 * scanning the source text — an interpolated fragment compiles to no CSS at all and the strip would
 * render transparent.
 */
const TONE: Record<Banner['kind'], { strip: string; text: string; button: string }> = {
  error: { strip: 'bg-danger-soft', text: 'text-danger', button: 'border-danger/40 text-danger' },
  warn: { strip: 'bg-warn-soft', text: 'text-warn', button: 'border-warn/40 text-warn' },
  info: { strip: 'bg-accent-soft', text: 'text-accent', button: 'border-accent/40 text-accent' },
};

const BANNER_BUTTON = 'rounded border px-2 py-0.5 text-xs';

/**
 * The message an `action: 'retry'` banner would send again, or null when this header cannot tell.
 *
 * `Banner` carries neither a conversation id nor a message id, so the only turn this surface can
 * identify is the failed one at the end of the conversation the user is currently looking at — and
 * its preceding user message is, by construction, the text to send again. Anything else is a guess:
 * re-sending the wrong question spends a real turn and drops an answer to it into a transcript
 * nobody asked it in.
 *
 * Returning null is therefore not a corner case to paper over. The banner keeps saying what went
 * wrong and says plainly where to ask again, which is the honest version of a button that would
 * otherwise send something nobody asked for.
 */
function retryableText(conversation: Conversation | undefined): string | null {
  const last = conversation?.messages.at(-1);
  if (!conversation || last?.role !== 'assistant' || last.status !== 'error') return null;
  const asked = conversation.messages.at(-2);
  return asked?.role === 'user' ? asked.text : null;
}

export function TopBar(): React.JSX.Element {
  const { auth, refresh } = useAuth();
  const [health, setHealth] = useState<Health>('checking');
  const banner = useChatStore((s) => s.banner);
  const activeId = useChatStore((s) => s.activeId);
  // The derived string, not the conversation it is derived from. Subscribing to the whole active
  // conversation re-rendered this header — health poll, nav, account, banner and all — on every
  // token batch of every turn, roughly sixty times a second, to recompute a string that changes at
  // most once per turn. Zustand compares the selector's *result*, so returning `string | null`
  // keeps the header out of the streaming render path entirely.
  const retryText = useChatStore((s) =>
    retryableText(s.activeId ? s.conversations[s.activeId] : undefined),
  );
  // The same test App.tsx uses to decide whether the sidebar is mounted: `/` is the chat surface,
  // and it is the only route with a composer to send anything through.
  const onChat = useLocation().pathname === '/';

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

        <Nav />

        <span
          className="flex items-center gap-1.5 text-xs text-ink-muted"
          title={`Chemclaw service: ${health}`}
        >
          <span
            className={
              health === 'ok'
                ? 'text-ok'
                : health === 'down'
                  ? 'text-danger'
                  : 'text-ink-muted'
            }
          >
            ●
          </span>
          {health === 'ok' ? 'connected' : health === 'down' ? 'unreachable' : 'checking'}
        </span>

        {auth.mode === 'dev' && (
          <span
            className="rounded border border-warn/40 bg-warn-soft px-1.5 py-0.5 text-xs text-warn"
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
                className="rounded bg-accent px-2.5 py-1 text-white"
              >
                Sign in
              </button>
            ))}
        </div>
      </div>

      {banner && (
        <div
          className={cn(
            'flex items-center gap-3 border-t border-border-subtle px-4 py-1.5',
            TONE[banner.kind].strip,
          )}
        >
          <p className={cn('text-sm', TONE[banner.kind].text)}>{banner.text}</p>
          {banner.action === 'reset' && activeId && (
            <button
              type="button"
              onClick={() => void resetSession(activeId, auth)}
              className={cn(BANNER_BUTTON, TONE[banner.kind].button)}
            >
              Start a fresh session
            </button>
          )}
          {banner.action === 'reauth' && (
            <button
              type="button"
              onClick={() => void auth.login()}
              className={cn(BANNER_BUTTON, TONE[banner.kind].button)}
            >
              Sign in again
            </button>
          )}
          {/* `retryable` on the service's error taxonomy means "asking again, unchanged, could
              plausibly succeed", so the affordance is exactly that and says so. It opens a NEW
              turn rather than reviving the failed one — the store has no way to re-run a message in
              place, and a transcript that shows the question twice is a truthful record of having
              asked twice.

              Through the composer's own prefill channel, the one the approval buttons already use,
              rather than by calling `sendMessage` from here. The composer owns two things this
              header cannot see: the dry-run toggle, which is component-local state, and the length
              and lock checks. A send issued from up here would quietly turn an estimate-only
              request into a full turn while the toggle beside the textbox still read "on". */}
          {banner.action === 'retry' &&
            (onChat && retryText !== null ? (
              <button
                type="button"
                title="Sends that message again, unchanged, with the composer's current settings."
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent('chemclaw:prefill', {
                      detail: { text: retryText, autoSend: true },
                    }),
                  )
                }
                className={cn(BANNER_BUTTON, TONE[banner.kind].button)}
              >
                Ask again
              </button>
            ) : (
              // Off the chat route the composer is not mounted, so the button would dispatch into
              // nothing. Same sentence for both misses, because they are the same miss: this header
              // cannot see the turn the banner is about.
              <span className="text-xs text-ink-muted">
                Ask again in the conversation this failed in.
              </span>
            ))}
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

/**
 * The workbench's four surfaces.
 *
 * Chat is one of them rather than the frame the others hang off: a durable job outlives the
 * conversation that launched it, and a reviewer signing off on proposed notes is not having a
 * conversation at all. `end` on the chat link so it is not marked active for every route, since
 * every path starts with `/`.
 *
 * Four is the whole list, deliberately. `/metrics` and `/schedules` are the backend routes a
 * workbench would grow towards next and they are off the BFF whitelist on purpose — this nav is
 * where that decision either holds or quietly stops holding.
 */
function Nav(): React.JSX.Element {
  const link = ({ isActive }: { isActive: boolean }): string =>
    cn(
      'rounded px-2 py-0.5 text-sm transition-colors',
      isActive ? 'bg-accent-soft text-accent' : 'text-ink-muted hover:text-ink',
    );

  return (
    <nav className="flex items-center gap-0.5" aria-label="Workbench">
      <NavLink to="/" end className={link}>
        Chat
      </NavLink>
      <NavLink to="/jobs" className={link}>
        Jobs
      </NavLink>
      <NavLink to="/review" className={link}>
        Review
      </NavLink>
      <NavLink to="/approvals" className={link}>
        Approvals
      </NavLink>
    </nav>
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
