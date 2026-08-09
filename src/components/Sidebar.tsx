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

import { useEffect, useState } from 'react';
import { MoreHorizontal, Plus, Trash2, TriangleAlert } from 'lucide-react';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** Pull server-side sessions once. Anything not known locally is added as a stub. */
function useServerSessions(): 'idle' | 'degraded' {
  const { auth } = useAuth();
  const [health, setHealth] = useState<'idle' | 'degraded'>('idle');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const remote = await api.listSessions(() => auth.getAccessToken());
        if (cancelled || remote.length === 0) return;
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
  }, [auth]);

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
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
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
  const order = useChatStore((s) => s.order);
  const activeId = useChatStore((s) => s.activeId);
  const conversations = useChatStore((s) => s.conversations);
  const degraded = useServerSessions();

  // The store prepends on create but server-merged stubs were appended, so a conversation used
  // ten minutes ago could sit below one from last month.
  const sorted = [...order].sort(
    (a, b) => (conversations[b]?.updatedAt ?? 0) - (conversations[a]?.updatedAt ?? 0),
  );

  return (
    <>
      <div className="p-3">
        <Button
          variant="outline"
          className="w-full justify-start"
          onClick={() => {
            useChatStore.getState().createConversation();
            onNavigate?.();
          }}
        >
          <Plus />
          New conversation
        </Button>
      </div>

      <nav aria-label="Conversations" className="flex-1 overflow-y-auto px-2 pb-3">
        <ul className="space-y-1">
          {sorted.map((id) => (
            <ConversationRow
              key={id}
              id={id}
              active={id === activeId}
              onSelect={() => {
                const title = conversations[id]?.title ?? 'conversation';
                const count = conversations[id]?.messages.length ?? 0;
                useChatStore.getState().selectConversation(id);
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

      <div className="space-y-2 border-t border-border-subtle p-3">
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
