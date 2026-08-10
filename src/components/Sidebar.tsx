/**
 * Conversation list.
 *
 * Sessions are listed from the server when the backend supports `GET /sessions`, and merged with
 * the local list so a conversation started on another device shows up. Locally-known conversations
 * always win on title, since the server can only derive one from the first stored message.
 *
 * The panel body is shared between the persistent column (>= lg) and the Sheet below it. That
 * sharing is the point: the sidebar used to `display:none` under 768px with no replacement, which
 * took the conversation switcher, "New conversation" and — worst — the "Reset app" recovery
 * control off phones entirely. Reset app is the documented way out of the poisoned-state bug the
 * store's v2 key bump exists for, so losing it on the device most likely to hit that bug was the
 * sharpest edge in the product.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { MoreHorizontal, Plus, Search, Trash2, TriangleAlert } from 'lucide-react';
import { api } from '../api/client.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { useChatStore, newConversation } from '../state/chatStore.ts';
import { announceStatus } from '../state/announce.ts';
import { relativeTime } from '../lib/format.ts';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ConfirmDialog } from '@/components/chem/ConfirmDialog';
import { StatusDot } from '@/components/chem/StatusDot';
import { NotifyToggle } from '@/components/chem/NotifyToggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** Pull server-side sessions once. Anything not known locally is added as a stub. */
function useServerSessions(): 'idle' | 'degraded' {
  const { auth, ready } = useAuth();
  const [health, setHealth] = useState<'idle' | 'degraded'>('idle');

  useEffect(() => {
    // The placeholder provider throws rather than sending an unauthenticated request, so running
    // this before auth resolves would set `degraded` on every single boot.
    if (!ready) return;
    let cancelled = false;
    void (async () => {
      try {
        const remote = await api.listSessions(() => auth.getAccessToken());
        if (cancelled) return;
        // Reset on success: without this a single failure latched the warning permanently, so a
        // transient hiccup left "showing local conversations only" on screen for the session.
        setHealth('idle');
        if (remote.length === 0) return;
        const state = useChatStore.getState();
        const known = new Set(
          Object.values(state.conversations)
            .map((c) => c.sessionId)
            .filter(Boolean),
        );
        const additions = remote.filter((s) => !known.has(s.session_id));
        if (additions.length === 0) return;

        useChatStore.setState((s) => {
          const next = { ...s.conversations };
          const ids: string[] = [];
          for (const summary of additions) {
            const created = summary.created_at ? Date.parse(summary.created_at) : Date.now();
            const conversation = {
              ...newConversation(),
              sessionId: summary.session_id,
              title: summary.title?.trim() || 'Earlier conversation',
              createdAt: created,
              // Was left at Date.now() from newConversation(), so every conversation restored
              // from the server read "just now" — the one thing a timestamp exists to deny.
              updatedAt: created,
              // The backend has a transcript for this one, so the rehydrate effect should read it.
              sessionOrigin: 'server' as const,
            };
            next[conversation.id] = conversation;
            ids.push(conversation.id);
          }
          return { conversations: next, order: [...s.order, ...ids] };
        });
      } catch {
        // A backend without the listing endpoint and a backend that refused our token are not the
        // same thing, and silently showing a local-only list made them look identical. Not worth
        // a banner, but worth saying somewhere.
        if (!cancelled) setHealth('degraded');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth, ready]);

  return health;
}

function ConversationRow({
  id,
  active,
  onSelect,
}: {
  id: string;
  active: boolean;
  onSelect: () => void;
}): React.JSX.Element | null {
  const conversation = useChatStore((s) => s.conversations[id]);
  if (!conversation) return null;

  return (
    <li className="group/row relative">
      <button
        type="button"
        onClick={onSelect}
        // aria-current is the only machine-readable "you are here"; a background tint alone was
        // both low-contrast and invisible to assistive tech.
        aria-current={active ? 'page' : undefined}
        className={cn(
          'w-full rounded-lg px-2.5 py-2 pr-9 text-left transition-colors',
          'focus-ring',
          active ? 'bg-surface-raised shadow-2xs' : 'hover:bg-surface-raised/60',
        )}
      >
        <span className="flex items-center gap-1.5">
          {conversation.contextLost && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <TriangleAlert aria-hidden className="size-3 shrink-0 text-warn" />
                  <span className="sr-only-live">Server session was replaced.</span>
                </span>
              </TooltipTrigger>
              <TooltipContent>Server session was replaced</TooltipContent>
            </Tooltip>
          )}
          <span className="truncate text-sm">{conversation.title}</span>
        </span>
        <span className="mt-0.5 block text-2xs text-ink-subtle">
          {relativeTime(conversation.updatedAt)}
        </span>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Actions for ${conversation.title}`}
            className={cn(
              'absolute top-1.5 right-1.5 opacity-0 transition-opacity',
              'group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
            )}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/* deleteConversation has existed in the store from the start and no UI ever called it,
              so the only way to remove one conversation was to delete all of them. */}
          <DropdownMenuItem
            tone="danger"
            onSelect={() => useChatStore.getState().deleteConversation(id)}
          >
            <Trash2 />
            Delete conversation
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/** The panel body, shared by the persistent column and the mobile Sheet. */
export function SidebarBody({ onNavigate }: { onNavigate?: () => void }): React.JSX.Element {
  const navigate = useNavigate();
  const order = useChatStore((s) => s.order);
  const activeId = useChatStore((s) => s.activeId);
  const conversations = useChatStore((s) => s.conversations);
  const degraded = useServerSessions();
  const throttled = useChatStore((s) => s.jobStreamsThrottled);
  const [query, setQuery] = useState('');

  const needle = query.trim().toLowerCase();

  /**
   * Ordering and filtering together, memoised, and the message scan skipped when nothing is typed.
   *
   * This all ran in the render body, so it re-sorted and lowercased every message of every
   * conversation on every render — and `conversations` gets a new identity on every store write,
   * which during a turn is once per animation frame. A chemist with thirty conversations open was
   * rescanning their whole local history sixty times a second to filter a box they were not using.
   */
  const matches = useMemo(() => {
    // The store prepends on create but server-merged stubs were appended, so a conversation used
    // ten minutes ago could sit below one from last month.
    const sorted = [...order].sort(
      (a, b) => (conversations[b]?.updatedAt ?? 0) - (conversations[a]?.updatedAt ?? 0),
    );
    if (!needle) return sorted;
    // Titles are derived from the first message, so searching them alone would miss anything said
    // later — which is most of what a chemist wants to find again (a batch number, a ligand).
    return sorted.filter((id) => {
      const c = conversations[id];
      if (!c) return false;
      if (c.title.toLowerCase().includes(needle)) return true;
      return c.messages.some((m) =>
        (m.role === 'user' ? m.text : (m.finalText ?? m.streamedText))
          .toLowerCase()
          .includes(needle),
      );
    });
  }, [needle, conversations, order]);

  return (
    <>
      <div className="p-3">
        <Button
          variant="outline"
          className="w-full justify-start"
          onClick={() => {
            // Push, so Back returns to where they were. The URL-sync effect only ever replaces.
            navigate(`/c/${useChatStore.getState().createConversation()}`);
            onNavigate?.();
          }}
        >
          <Plus />
          New conversation
        </Button>
      </div>

      <div className="px-3 pb-2">
        <label htmlFor="conversation-search" className="sr-only-live">
          Search conversations
        </label>
        <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5 focus-within:border-brand focus-within:ring-2 focus-within:ring-ring/25">
          <Search aria-hidden className="size-3.5 shrink-0 text-ink-subtle" />
          <input
            id="conversation-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-subtle"
          />
        </div>
      </div>

      <nav aria-label="Conversations" className="flex-1 overflow-y-auto px-2 pb-3">
        {needle && matches.length === 0 && (
          <p className="px-2.5 py-2 text-xs text-ink-muted">
            Nothing matches “{query.trim()}”. Only conversations stored in this browser are
            searched.
          </p>
        )}
        <ul className="space-y-1">
          {matches.map((id) => (
            <ConversationRow
              key={id}
              id={id}
              active={id === activeId}
              onSelect={() => {
                const title = conversations[id]?.title ?? 'conversation';
                const count = conversations[id]?.messages.length ?? 0;
                navigate(`/c/${id}`);
                onNavigate?.();
                // Land the reader in the transcript rather than leaving focus on a list item
                // whose content just changed underneath it, and say what they landed in — the
                // transcript itself gives no spoken cue that it swapped.
                document.getElementById('transcript')?.focus({ preventScroll: true });
                announceStatus(`Opened ${title}. ${count} message${count === 1 ? '' : 's'}.`);
              }}
            />
          ))}
        </ul>
      </nav>

      <div className="space-y-3 border-t border-border-subtle p-3">
        <NotifyToggle />

        {throttled && (
          <StatusDot
            status="warn"
            label="Watching fewer conversations for finished jobs — the service limited concurrent streams."
            className="items-start text-2xs leading-snug"
          />
        )}

        {degraded === 'degraded' && (
          <StatusDot
            status="warn"
            label="Showing local conversations only — the service did not return a list."
            className="items-start text-2xs leading-snug"
          />
        )}
        <ConfirmDialog
          trigger={
            <Button variant="outline-destructive" size="sm" className="w-full">
              Reset app
            </Button>
          }
          title="Reset the app?"
          description="This clears every conversation stored in this browser and starts fresh. Server-side sessions are not deleted, but this device will no longer have a link to them."
          confirmLabel="Reset everything"
          variant="destructive"
          onConfirm={() => useChatStore.getState().clearAll()}
        />
      </div>
    </>
  );
}

export function Sidebar(): React.JSX.Element {
  return (
    <aside className="hidden w-sidebar shrink-0 flex-col border-r border-border-subtle bg-surface-sunken lg:flex">
      <SidebarBody />
    </aside>
  );
}
