/**
 * Conversation list.
 *
 * Sessions are listed from the server when the backend supports `GET /sessions`, and merged with
 * the local list so a conversation started on another device shows up. Locally-known conversations
 * always win on title, since the server can only derive one from the first stored message.
 */

import { memo, useEffect } from 'react';
import { api } from '../api/client.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { useChatStore, newConversation } from '../state/chatStore.ts';
import { relativeTime } from '../lib/format.ts';
import { cn } from '../lib/cn.ts';

/**
 * One row, subscribed to its own conversation's primitives.
 *
 * The sidebar used to subscribe to the whole `conversations` record, which `updateAssistant`
 * replaces on every store write — so the entire list re-rendered once per streamed token, which
 * is precisely the thing the store's own docstring says selector-scoped subscriptions exist to
 * prevent. `order` is identity-stable across assistant writes (only create/delete touch it), so
 * per-row primitive selectors keep the list out of the per-token path entirely.
 *
 * Deliberately not `useShallow` over a projected object: that re-runs the projector on every store
 * change and shallow-compares its result, and a projector allocating a fresh object never compares
 * equal — so it would cost the same re-render while looking like an optimisation.
 */
const SidebarRow = memo(function SidebarRow({
  id,
  active,
}: {
  id: string;
  active: boolean;
}): React.JSX.Element | null {
  const title = useChatStore((s) => s.conversations[id]?.title);
  const updatedAt = useChatStore((s) => s.conversations[id]?.updatedAt);
  const contextLost = useChatStore((s) => s.conversations[id]?.contextLost ?? false);
  if (title === undefined) return null;

  return (
    <button
      type="button"
      aria-current={active ? 'true' : undefined}
      onClick={() => useChatStore.getState().selectConversation(id)}
      className={cn(
        'mb-1 w-full rounded-md px-2.5 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
        active ? 'bg-surface-raised' : 'hover:bg-surface-raised/60',
      )}
    >
      <div className="flex items-center gap-1.5">
        {contextLost && (
          <span className="text-warn" title="Server session was replaced">
            ●
          </span>
        )}
        <span className="truncate text-sm">{title}</span>
      </div>
      <span className="text-xs text-ink-muted">{relativeTime(updatedAt ?? 0)}</span>
    </button>
  );
});

export function Sidebar(): React.JSX.Element {
  const { auth } = useAuth();
  const order = useChatStore((s) => s.order);
  const activeId = useChatStore((s) => s.activeId);

  // Pull server-side sessions once. Any conversation we do not already know locally is added as
  // a stub; opening it hydrates the transcript.
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
            const conversation = {
              ...newConversation(),
              sessionId: summary.session_id,
              title: summary.title?.trim() || 'Earlier conversation',
              createdAt: summary.created_at ? Date.parse(summary.created_at) : Date.now(),
            };
            next[conversation.id] = conversation;
            ids.push(conversation.id);
          }
          return { conversations: next, order: [...s.order, ...ids] };
        });
      } catch {
        // A backend without the listing endpoint, or an auth hiccup — the sidebar simply stays
        // local-only. Not worth a banner.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth]);

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-border-subtle bg-surface-sunken md:flex">
      <div className="p-3">
        <button
          type="button"
          onClick={() => useChatStore.getState().createConversation()}
          className="w-full rounded-lg border border-border-subtle bg-surface-raised px-3 py-2 text-sm font-medium hover:brightness-95"
        >
          + New conversation
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-3">
        {order.map((id) => (
          <SidebarRow key={id} id={id} active={id === activeId} />
        ))}
      </nav>

      <div className="border-t border-border-subtle p-3">
        <button
          type="button"
          onClick={() => {
            if (window.confirm('Reset the app? This clears all conversations and starts fresh.')) {
              useChatStore.getState().clearAll();
            }
          }}
          className="w-full rounded-lg border border-danger/30 px-3 py-2 text-xs text-danger hover:bg-danger/10"
        >
          Reset app
        </button>
      </div>
    </aside>
  );
}
