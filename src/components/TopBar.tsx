/**
 * Header: service health, auth state, the error banner, the draw-structures preference and (below
 * `lg`) the entity-rail drawer. The health probe is unauthenticated and pauses while hidden; an
 * offline marker shows when the browser reports offline. The banner renders `retry` as well as
 * `reset` and `reauth` actions.
 */

import { useEffect, useState } from 'react';
import { Menu, RefreshCw, X } from 'lucide-react';
import { config } from '../env.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { keys, useApiQuery } from '../api/queryClient.ts';
import { useChatStore } from '../state/chatStore.ts';
import { useOffline } from '../hooks/useOffline.ts';
import { resetSession } from '../state/sendMessage.ts';
import { SidebarBody } from './Sidebar.tsx';
import { EntityRailTrigger } from './EntityRail.tsx';
import { ExhibitPaneTrigger } from './exhibits/RightColumn.tsx';
import { MembersTrigger } from './MembersPanel.tsx';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { StatusDot, type Status } from '@/components/chem/StatusDot';
import { ThemeToggle } from '@/components/chem/ThemeToggle';
import { DrawStructuresToggle } from '@/components/chem/DrawStructuresToggle';
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

/**
 * How often the service is probed. Each probe has its own deadline (`HEALTH_TIMEOUT_MS`, shorter
 * than this), so "checking" is transient. Exported for tests.
 */
export const HEALTH_POLL_MS = 30_000;
const HEALTH_TIMEOUT_MS = 5_000;

const HEALTH: Record<Health, { status: Status; label: string }> = {
  checking: { status: 'pending', label: 'checking' },
  ok: { status: 'ok', label: 'connected' },
  down: { status: 'down', label: 'unreachable' },
};

export function TopBar({
  onRetry,
  conversationId,
}: {
  onRetry?: () => void;
  /**
   * The conversation shown, for the small-screen rail drawer; absent on non-conversation screens.
   */
  conversationId?: string;
}): React.JSX.Element {
  const { auth, refresh } = useAuth();
  const [drawer, setDrawer] = useState(false);
  const banner = useChatStore((s) => s.banner);
  const activeId = useChatStore((s) => s.activeId);
  const offline = useOffline();

  /**
   * The health probe — the one read that refetches on focus and reconnect (disabled globally in
   * `queryClient.ts`), so the dot recovers as soon as the network returns. `refetchInterval` polls;
   * react-query skips overlapping probes and pauses in the background. `api_health` resolves
   * `false` rather than throwing, so `isPending` is true only before the first answer.
   */
  const { data: reachable, isPending: probing } = useApiQuery({
    queryKey: keys.health,
    queryFn: api_health,
    refetchInterval: HEALTH_POLL_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    staleTime: 0,
  });
  const health: Health = probing ? 'checking' : reachable ? 'ok' : 'down';

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

        {/* The app's only h1. */}
        <h1 className="text-sm font-semibold tracking-tight">Chemclaw</h1>

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center">
              {/* The dot is never the only carrier: `StatusDot` renders the label for assistive tech, so this visible copy is `aria-hidden`. */}
              <StatusDot status={meta.status} label={meta.label} showLabel={false} />
              <span
                aria-hidden
                className="sr-only-live sm:not-sr-only sm:ml-1.5 sm:text-xs sm:text-ink-muted"
              >
                {meta.label}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent>Chemclaw service: {meta.label}</TooltipContent>
        </Tooltip>

        {/* Offline is shown beside the service dot, never "online": `navigator.onLine` is trustworthy only when false. */}
        {offline && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center">
                <StatusDot status="down" label="offline" showLabel={false} />
                <span
                  aria-hidden
                  className="sr-only-live sm:not-sr-only sm:ml-1.5 sm:text-xs sm:text-ink-muted"
                >
                  offline
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              This device reports no network connection, so nothing here can reach the service. The
              browser only knows about the link — a connected network with no route out still reads
              as online.
            </TooltipContent>
          </Tooltip>
        )}

        {auth.mode === 'dev' && (
          <Badge tone="warn" className="hidden sm:inline-flex">
            dev auth — no sign-in
          </Badge>
        )}

        <div className="ml-auto flex items-center gap-1">
          {/* Before the theme toggle: content controls first. */}
          {/* The artefacts toggle (column at `lg`, sheet below); absent where the deployment has none. */}
          {conversationId && <ExhibitPaneTrigger conversationId={conversationId} />}
          {conversationId && <EntityRailTrigger conversationId={conversationId} />}
          {/* Who else is in this conversation — a fact about the conversation, so not in the account menu. */}
          {conversationId && <MembersTrigger conversationId={conversationId} />}
          <DrawStructuresToggle />
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
          {banner.retryAfterSeconds !== undefined && (
            <Countdown seconds={banner.retryAfterSeconds} />
          )}

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

/**
 * The remaining `Retry-After` wait, ticking to zero. `aria-hidden`: the banner (`role="alert"`)
 * already announced the wait once.
 */
function Countdown({ seconds }: { seconds: number }): React.JSX.Element | null {
  // Restart on a new wait via render-phase adjustment, so the previous number never paints.
  const [wait, setWait] = useState(seconds);
  const [remaining, setRemaining] = useState(seconds);
  if (wait !== seconds) {
    setWait(seconds);
    setRemaining(seconds);
  }

  useEffect(() => {
    if (seconds <= 0) return;
    // Left running at zero: the updater is idempotent and stops re-rendering on its own.
    const timer = setInterval(() => setRemaining((left) => Math.max(0, left - 1)), 1_000);
    return () => clearInterval(timer);
  }, [seconds]);

  if (remaining <= 0) return null;
  return (
    <span aria-hidden className="text-sm tabular-nums text-danger-ink">
      {remaining}s
    </span>
  );
}

/**
 * The health probe, local so it never acquires a token. Bounded by its own controller (cleared on
 * success); a timeout reads as unreachable.
 */
async function api_health(): Promise<boolean> {
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.apiBase}/healthz`, {
      cache: 'no-store',
      signal: abort.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(deadline);
  }
}
