/**
 * Header: service health, auth state, and the error banner.
 *
 * The health poll stays unauthenticated and local so it cannot acquire a token on every tick, and
 * it now pauses while the tab is hidden — a backgrounded tab used to keep hitting the BFF every
 * 30s for as long as it was left open.
 *
 * The banner renders the `retry` action. `sendMessage` has always set it for the retryable kinds
 * (503 capacity, and the BFF's own 502 mapped to `network`), and this component only handled
 * `reset` and `reauth` — so the two failures most likely to be transient produced a red bar with
 * no way forward, and the message the chemist had just typed was already gone from the composer.
 */

import { useEffect, useState } from 'react';
import { Menu, RefreshCw, X } from 'lucide-react';
import { config } from '../env.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { useChatStore } from '../state/chatStore.ts';
import { resetSession } from '../state/sendMessage.ts';
import { SidebarBody } from './Sidebar.tsx';
import { ApprovalsInbox } from './ApprovalsInbox.tsx';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { StatusDot, type Status } from '@/components/chem/StatusDot';
import { ThemeToggle } from '@/components/chem/ThemeToggle';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type Health = 'checking' | 'ok' | 'down';

const HEALTH: Record<Health, { status: Status; label: string }> = {
  checking: { status: 'pending', label: 'checking' },
  ok: { status: 'ok', label: 'connected' },
  down: { status: 'down', label: 'unreachable' },
};

export function TopBar({ onRetry }: { onRetry?: () => void }): React.JSX.Element {
  const { auth, refresh } = useAuth();
  const [health, setHealth] = useState<Health>('checking');
  const [drawer, setDrawer] = useState(false);
  const banner = useChatStore((s) => s.banner);
  const activeId = useChatStore((s) => s.activeId);

  useEffect(() => {
    let cancelled = false;
    const check = (): void => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void api_health().then((ok) => {
        if (!cancelled) setHealth(ok ? 'ok' : 'down');
      });
    };
    check();
    const timer = setInterval(check, 30_000);
    // Catch up immediately on return rather than waiting out the rest of the interval.
    document.addEventListener('visibilitychange', check);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);

  const account = auth.account;
  const meta = HEALTH[health];

  return (
    <header className="border-b border-border-subtle bg-surface-raised/85 backdrop-blur-sm">
      <div className="flex items-center gap-2 px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-4">
        <Sheet open={drawer} onOpenChange={setDrawer}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Conversations" className="lg:hidden">
              <Menu />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" title="Conversations" className="p-0">
            <div className="flex h-full flex-col pt-10">
              <SidebarBody onNavigate={() => setDrawer(false)} />
            </div>
          </SheetContent>
        </Sheet>

        {/* The app's only h1. There was none at all in the running app — only on its two failure
            screens — so heading navigation began at h2 with no root above it. */}
        <h1 className="text-sm font-semibold tracking-tight">Chemclaw</h1>

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center">
              {/* The label is hidden on the narrowest screens but never removed: the dot's colour
                  must not be the only carrier of the state. */}
              <StatusDot status={meta.status} label={meta.label} showLabel={false} />
              <span className="sr-only-live sm:not-sr-only sm:ml-1.5 sm:text-xs sm:text-ink-muted">
                {meta.label}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent>Chemclaw service: {meta.label}</TooltipContent>
        </Tooltip>

        {auth.mode === 'dev' && (
          <Badge tone="warn" className="hidden sm:inline-flex">
            dev auth — no sign-in
          </Badge>
        )}

        <div className="ml-auto flex items-center gap-1">
          {/* Before the theme toggle, because it is the only control here that can be urgent. */}
          <ApprovalsInbox />
          <ThemeToggle />

          {auth.mode === 'msal' && !account && (
            <Button
              size="xs"
              onClick={() => {
                void auth.login();
                refresh();
              }}
            >
              Sign in
            </Button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="xs"
                aria-label="Account and build details"
                className="max-w-32 truncate"
              >
                {account?.name ?? config.appVersion}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Build {config.appVersion}</DropdownMenuLabel>
              {auth.mode === 'dev' && (
                <DropdownMenuLabel className="max-w-56 text-2xs font-normal whitespace-normal text-ink-muted">
                  Dev auth: requests are attributed to a shared principal, not to you.
                </DropdownMenuLabel>
              )}
              {account && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="font-normal text-ink">
                    {account.username}
                  </DropdownMenuLabel>
                  <DropdownMenuItem onSelect={() => void auth.logout()}>Sign out</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {banner && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-t border-border-subtle bg-danger-soft px-4 py-2"
        >
          <p className="text-sm text-danger-ink">{banner.text}</p>

          {banner.action === 'retry' && onRetry && (
            <Button variant="outline-destructive" size="xs" onClick={onRetry}>
              <RefreshCw />
              Retry
            </Button>
          )}
          {banner.action === 'reset' && activeId && (
            <Button
              variant="outline-destructive"
              size="xs"
              onClick={() => void resetSession(activeId, auth)}
            >
              Start a fresh session
            </Button>
          )}
          {banner.action === 'reauth' && (
            <Button variant="outline-destructive" size="xs" onClick={() => void auth.login()}>
              Sign in again
            </Button>
          )}

          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss"
            className="tap-target ml-auto"
            onClick={() => useChatStore.getState().setBanner(null)}
          >
            <X />
          </Button>
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
