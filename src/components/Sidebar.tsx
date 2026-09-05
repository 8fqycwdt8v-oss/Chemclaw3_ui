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

import { useCallback, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useLocation, useNavigate } from 'react-router';
import {
  FileCheck2,
  FlaskConical,
  GitBranch,
  MoreHorizontal,
  Plus,
  Search,
  Server,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { api, type SessionSummary } from '../api/client.ts';
import { ApiError } from '../api/errors.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import type { AuthProvider } from '../auth/types.ts';
import { useChatStore, newConversation } from '../state/chatStore.ts';
import type { ChatState } from '../state/chatStore.ts';
import type { Conversation } from '../state/types.ts';
import { announceStatus } from '../state/announce.ts';
import { relativeTime } from '../lib/format.ts';
import { logger } from '../lib/logger.ts';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
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

/**
 * Fold one page of the service's sessions into the local list.
 *
 * Shared by the first read and by "Load more", so the two cannot drift about what a restored
 * conversation looks like. Returns the ids it added, which is what tells the caller whether the
 * page was worth asking for.
 */
function adoptSessions(remote: SessionSummary[]): number {
  const state = useChatStore.getState();
  const known = new Set(
    Object.values(state.conversations)
      .map((c) => c.sessionId)
      .filter(Boolean),
  );
  const additions = remote.filter((s) => !known.has(s.session_id));
  if (additions.length === 0) return 0;

  useChatStore.setState((s) => {
    const next = { ...s.conversations };
    const ids: string[] = [];
    for (const summary of additions) {
      const created = summary.created_at ? Date.parse(summary.created_at) : Date.now();
      // **The service names its sessions now, and this used to ignore it.** The comment here read
      // "the server has never sent one, so the guard was decoration in front of a constant" — true
      // when written, false since `routes/sessions.py` began constructing
      // `SessionSummary(..., title=title)` from the session's first user message. The guard was
      // deleted one release before it became load-bearing, so every restored conversation read
      // "Earlier conversation" until somebody clicked into it and `hydrateTranscript` renamed it
      // from a transcript it had to fetch first. The placeholder stays as the fallback for a
      // service that predates the field, and for a session minted before anyone had spoken.
      const named = summary.title?.trim();
      // `updated_at` is the newest stored message; `created_at` is when the session was *started*.
      // Sorting by the second is what put a conversation opened last Tuesday and abandoned above
      // one used an hour ago — the bug this file's own sort comment names.
      const touched = summary.updated_at ? Date.parse(summary.updated_at) : created;
      const conversation = {
        ...newConversation(),
        sessionId: summary.session_id,
        title: named || 'Earlier conversation',
        createdAt: created,
        // Was left at Date.now() from newConversation(), so every conversation restored
        // from the server read "just now" — the one thing a timestamp exists to deny.
        updatedAt: Number.isNaN(touched) ? created : touched,
        // The backend has a transcript for this one, so the rehydrate effect should read it.
        sessionOrigin: 'server' as const,
      };
      next[conversation.id] = conversation;
      ids.push(conversation.id);
    }
    return { conversations: next, order: [...s.order, ...ids] };
  });
  return additions.length;
}

/**
 * Pull server-side sessions. Anything not known locally is added as a stub.
 *
 * Paged, because the service caps a listing at `service_max_listed_sessions` (100) and advertises
 * `X-Next-Cursor` when there may be more — so conversation 101 was not below a fold, it was never
 * fetched, and nothing said so. The first page is read on mount; the rest is a control, because
 * pulling every page on boot would be a hundred round trips for a list nobody scrolled.
 */
function useServerSessions(): {
  health: 'idle' | 'degraded';
  more: (() => void) | null;
  loadingMore: boolean;
} {
  const { auth, ready } = useAuth();
  const [health, setHealth] = useState<'idle' | 'degraded'>('idle');
  const [cursor, setCursor] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    // The placeholder provider throws rather than sending an unauthenticated request, so running
    // this before auth resolves would set `degraded` on every single boot.
    if (!ready) return;
    let cancelled = false;
    void (async () => {
      try {
        const page = await api.pageSessions(auth);
        if (cancelled) return;
        // Reset on success: without this a single failure latched the warning permanently, so a
        // transient hiccup left "showing local conversations only" on screen for the session.
        setHealth('idle');
        setCursor(page.next);
        adoptSessions(page.sessions);
      } catch (err) {
        // A backend without the listing endpoint and a backend that refused our token are not the
        // same thing, and silently showing a local-only list made them look identical. Not worth
        // a banner, but worth saying somewhere — and "somewhere" is now a real place rather than
        // a sentence in this comment.
        logger.warn('sessions.list_failed', {
          kind: err instanceof ApiError ? err.kind : 'unknown',
          ...(err instanceof ApiError && err.status ? { status: err.status } : {}),
        });
        if (!cancelled) setHealth('degraded');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth, ready]);

  const more = useCallback(() => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    void api
      .pageSessions(auth, cursor)
      .then((page) => {
        setCursor(page.next);
        adoptSessions(page.sessions);
      })
      .catch((err: unknown) => {
        // A cursor this deployment cannot resume is a 422 and is final for this listing: clearing
        // it takes the control off screen rather than offering a button that will never work.
        logger.warn('sessions.page_failed', {
          kind: err instanceof ApiError ? err.kind : 'unknown',
        });
        setCursor('');
      })
      .finally(() => setLoadingMore(false));
  }, [auth, cursor, loadingMore]);

  return { health, more: cursor ? more : null, loadingMore };
}

/**
 * Everything in one conversation a search should reach, lowercased, cached on the conversation.
 *
 * Keyed on the conversation *object*, which the store replaces only when that conversation
 * actually changes — so a streaming turn rebuilds one entry per animation frame and the other
 * twenty-nine are read straight back. Without it the scan below allocated a lowercased copy of
 * every message body in every conversation on every frame: measured at 30 conversations × 200
 * messages, 2.1 ms per frame, i.e. ~128 ms of string work per second of streaming, for as long
 * as the reader has anything typed in the box.
 *
 * A `WeakMap` rather than an LRU because the right eviction rule is exactly "the conversation is
 * gone", and that is the one rule a `WeakMap` applies for free.
 */
const haystacks = new WeakMap<Conversation, string>();

function haystack(c: Conversation): string {
  const cached = haystacks.get(c);
  if (cached !== undefined) return cached;
  // Titles are derived from the first message, so searching them alone would miss anything said
  // later — which is most of what a chemist wants to find again (a batch number, a ligand).
  const built = [
    c.title,
    ...c.messages.map((m) => (m.role === 'user' ? m.text : m.finalText || m.streamedText)),
  ]
    .join('\n')
    .toLowerCase();
  haystacks.set(c, built);
  return built;
}

/**
 * The conversation ids this panel lists, newest first, narrowed by the search box.
 *
 * Exported and pure so the subscription above can be a shallow-compared array rather than the
 * whole conversations map — see the comment at its one call site.
 */
export function visibleConversationIds(state: ChatState, needle: string): string[] {
  // The store prepends on create but server-merged stubs were appended, so a conversation used
  // ten minutes ago could sit below one from last month.
  const sorted = [...state.order].sort(
    (a, b) => (state.conversations[b]?.updatedAt ?? 0) - (state.conversations[a]?.updatedAt ?? 0),
  );
  if (!needle) return sorted;
  return sorted.filter((id) => {
    const c = state.conversations[id];
    return c ? haystack(c).includes(needle) : false;
  });
}

/**
 * Remove a conversation from this browser *and* from the service.
 *
 * Server first, then local, and the order is the whole point: a local delete that ran first would
 * leave the caller with no session id to send if the request failed, and the chemist believing the
 * conversation was gone when the service still holds it.
 *
 * A failure is reported and the conversation stays. That is the honest outcome — "it is gone" is
 * the claim this function exists to make true — and it is recoverable: the row is still there to
 * try again.
 */
async function deleteConversation(id: string, auth: AuthProvider): Promise<void> {
  const sessionId = useChatStore.getState().conversations[id]?.sessionId;
  if (sessionId) {
    try {
      await api.deleteSession(sessionId, auth);
    } catch (err) {
      logger.warn('session.delete_failed', {
        kind: err instanceof ApiError ? err.kind : 'unknown',
      });
      useChatStore.getState().setBanner({
        kind: 'warn',
        text:
          err instanceof Error
            ? `This conversation was not deleted on the server: ${err.message}`
            : 'This conversation was not deleted on the server.',
        action: 'retry',
      });
      return;
    }
  }
  useChatStore.getState().deleteConversation(id);
}

/**
 * Copy this conversation onto a new session and open it.
 *
 * The local half is a fresh conversation pointed at the forked session with the parent's messages
 * carried over, so the branch reads as a branch rather than as an empty thread that happens to
 * share a history on the server. `sessionOrigin: 'server'` is deliberate: the service holds the
 * authoritative copy, and the transcript rehydrate is what reconciles the two if they differ.
 */
async function forkConversation(
  id: string,
  auth: AuthProvider,
  // `react-router`'s own `navigate` returns a promise, so a `void` parameter type would make every
  // call site a `no-misused-promises` error rather than this one declaration.
  navigate: (to: string) => void | Promise<void>,
): Promise<void> {
  const parent = useChatStore.getState().conversations[id];
  if (!parent?.sessionId) return;
  try {
    const { session_id } = await api.forkSession(parent.sessionId, auth);
    const branch = useChatStore.getState().adoptFork(id, session_id);
    if (branch) void navigate(`/c/${branch}`);
  } catch (err) {
    // 409 (a turn in flight) and 501 (no durable store) are both facts about *now*, and both are
    // recoverable by the reader — one by waiting, one by not asking again. A banner says which.
    useChatStore.getState().setBanner({
      kind: 'warn',
      text:
        err instanceof ApiError && err.status === 409
          ? 'This conversation has a turn running. A branch cannot be taken until it finishes.'
          : err instanceof ApiError && err.status === 501
            ? 'This deployment does not keep conversations on the server, so there is nothing to branch.'
            : err instanceof Error
              ? `This conversation was not branched: ${err.message}`
              : 'This conversation was not branched.',
    });
  }
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
  const { auth } = useAuth();
  const navigate = useNavigate();
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
              so the only way to remove one conversation was to delete all of them.

              **Two things were wrong with the version that gave it one.** It was a local map
              delete — the server session, its transcript, its checkpoints, its attachments and its
              ownership row all survived — so the chemist who deleted a conversation *because* it
              held something they did not want kept had been told something untrue. And it was one
              click on a 24px control, with no confirmation and no undo, in a codebase that confirms
              the plan decision, the protocol status move and "Clear all conversations".

              `onSelect` is prevented so the menu does not close and unmount the dialog it is
              opening. */}
          {/* Branch it, keeping both. The service copies the whole thread under a new id and
              refuses while a turn is in flight, so a fork is never a half-copied conversation.
              This is also the version of "edit and resend" that keeps the original: the message
              control refills the composer in place, this one gives the new question its own
              thread. */}
          <DropdownMenuItem
            onSelect={() => {
              // A statement body, not `() => void fork(…)`: the rule reads the expression form as
              // returning the promise. `forkConversation` reports its own failures through the
              // banner, so there is nothing here to await.
              void forkConversation(id, auth, navigate);
            }}
          >
            <GitBranch />
            Branch this conversation
          </DropdownMenuItem>
          <ConfirmDialog
            trigger={
              <DropdownMenuItem tone="danger" onSelect={(e) => e.preventDefault()}>
                <Trash2 />
                Delete conversation
              </DropdownMenuItem>
            }
            title="Delete this conversation?"
            description="It is removed from this browser and from the server — the transcript, its attachments and everything keyed by it. This cannot be undone."
            confirmLabel="Delete it"
            variant="destructive"
            onConfirm={() => void deleteConversation(id, auth)}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/** The panel body, shared by the persistent column and the mobile Sheet. */
/** A footer link that reports where it leads and whether you are already there. */
function SidebarLink({
  to,
  icon,
  children,
  onNavigate,
  count = 0,
}: {
  to: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  onNavigate?: () => void;
  /** How many things are waiting behind this link. `0` renders nothing at all — an empty badge
   *  reads as a broken one, and "nothing is waiting" is the state this app is in almost always. */
  count?: number;
}): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const current = location.pathname === to;
  return (
    <Button
      variant="ghost"
      size="sm"
      // `aria-current` rather than a colour alone: "you are on this page" is information, and the
      // conversation rows above already carry it for exactly the same reason.
      aria-current={current ? 'page' : undefined}
      className={cn('w-full justify-start', current && 'bg-surface-sunken')}
      onClick={() => {
        void navigate(to);
        onNavigate?.();
      }}
    >
      <span aria-hidden className="[&>svg]:size-4">
        {icon}
      </span>
      {children}
      {count > 0 && (
        // The number is in the accessible name rather than beside it as a bare digit: a screen
        // reader announcing "Review queue 2" says nothing about what the 2 counts, and this link
        // also leads to note proposals, which this badge is not about.
        <Badge tone="warn" className="ml-auto" aria-label={`${count} waiting on you`}>
          {count}
        </Badge>
      )}
    </Button>
  );
}

export function SidebarBody({ onNavigate }: { onNavigate?: () => void }): React.JSX.Element {
  const navigate = useNavigate();
  const activeId = useChatStore((s) => s.activeId);
  const { health: degraded, more: loadMoreSessions, loadingMore } = useServerSessions();
  const throttled = useChatStore((s) => s.jobStreamsThrottled);
  const streamsFailing = useChatStore((s) => s.jobStreamsFailing.length > 0);
  // A number, not the list: zustand compares with `Object.is`, so subscribing to the array itself
  // would re-render this whole panel on every `syncAwaiting` that changed nothing.
  const awaiting = useChatStore((s) => s.awaiting.length);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();

  // **The list is subscribed to as ids, not as the conversation map.** `updateAssistant` replaces
  // `state.conversations` on every animation-frame token flush, so `useChatStore((s) =>
  // s.conversations)` changed identity ~60×/s and re-rendered this whole panel — every row, each
  // with its own `DropdownMenu` — for the entire duration of every answer. Measured on the
  // sidebar alone: 2.8 ms/flush at one conversation, 50.5 ms at thirty, linear in a number the
  // chemist grows over time. The projection below still runs per write (that is what zustand
  // compares) but it returns the same *shallow* array while the order and the match set hold, so
  // React does nothing. `ConversationRow` already subscribes to its own conversation, so the one
  // row that genuinely changed still re-renders — which is the whole of what should.
  const visible = useChatStore(useShallow((s) => visibleConversationIds(s, needle)));

  return (
    <>
      <div className="p-3">
        <Button
          variant="outline"
          className="w-full justify-start"
          onClick={() => {
            // Push, so Back returns to where they were. The URL-sync effect only ever replaces.
            void navigate(`/c/${useChatStore.getState().createConversation()}`);
            onNavigate?.();
          }}
        >
          <Plus />
          New conversation
        </Button>
      </div>

      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5 focus-within:border-brand focus-within:ring-2 focus-within:ring-ring/25">
          <Search aria-hidden className="size-3.5 shrink-0 text-ink-subtle" />
          <input
            // Not an `id`: this component renders twice (the persistent column and the mobile
            // drawer), and a duplicated id makes both `htmlFor` associations point at one input
            // and `getElementById` resolve to the hidden copy. A data attribute is honest about
            // there being more than one.
            data-conversation-search=""
            // The accessible name moves onto the input with the id: a `<label htmlFor>` cannot
            // address one of two identical ids, and this component is rendered twice.
            aria-label="Search conversations"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-subtle"
          />
        </div>
      </div>

      <nav aria-label="Conversations" className="flex-1 overflow-y-auto px-2 pb-3">
        {needle && visible.length === 0 && (
          <p className="px-2.5 py-2 text-xs text-ink-muted">
            Nothing matches “{query.trim()}”. Only conversations stored in this browser are
            searched.
          </p>
        )}
        <ul className="space-y-1">
          {visible.map((id) => (
            <ConversationRow
              key={id}
              id={id}
              active={id === activeId}
              onSelect={() => {
                // Read at click time rather than subscribed: the announcement wants the title and
                // the length as they are when the reader acts, and subscribing to the map to get
                // them is what put this panel on the per-token render path.
                const opened = useChatStore.getState().conversations[id];
                const title = opened?.title ?? 'conversation';
                const count = opened?.messages.length ?? 0;
                void navigate(`/c/${id}`);
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

        {/* Only when the service said there is a next page. The listing is capped at
            `service_max_listed_sessions`, and before this the cap was invisible: conversation 101
            was not below a fold, it was never fetched, and nothing on screen said so. Hidden while
            a search is active, because the search reads what is in this browser and a page fetched
            now would not be in it yet. */}
        {loadMoreSessions && !needle && (
          <div className="px-1 pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              disabled={loadingMore}
              onClick={loadMoreSessions}
            >
              {loadingMore ? 'Loading…' : 'Load earlier conversations'}
            </Button>
          </div>
        )}
      </nav>

      <div className="space-y-3 border-t border-border-subtle p-3">
        {/* The screens that are not a conversation. In the footer rather than above the list
            because they are where a chemist goes occasionally, and the list is where they go
            every time. */}
        <nav aria-label="Other views" className="flex flex-col gap-1">
          {/* The count is on this link and not on a toast, because a question held open for a
              person has a deadline measured in days: it must be visible on every screen for as
              long as it is open, and gone the moment it is not. Before the service delivered
              `awaiting_answer` at all, the only trace of a paused campaign was a durable run that
              appeared to execute for a week (backend D-2026-09-05). */}
          <SidebarLink to="/review" icon={<FileCheck2 />} onNavigate={onNavigate} count={awaiting}>
            Review queue
          </SidebarLink>
          {/* A design outlives the conversation that drafted it — corrected by somebody who was
              not in that thread, run a week later — so it needs a way in that is not a session
              id, the same argument `/jobs` is here on. */}
          <SidebarLink to="/protocols" icon={<FlaskConical />} onNavigate={onNavigate}>
            Experiment protocols
          </SidebarLink>
          <SidebarLink to="/jobs" icon={<Server />} onNavigate={onNavigate}>
            Durable runs
          </SidebarLink>
        </nav>

        <NotifyToggle />

        {throttled && (
          <StatusDot
            status="warn"
            label="Watching fewer conversations for finished jobs — the service limited concurrent streams."
            className="items-start text-2xs leading-snug"
          />
        )}

        {/* Low-key, exactly like the throttle notice above it, and for the same reason: nothing
            the reader can act on, but "a durable run finished and nobody told you" is not a state
            to leave unsaid. Until now every failure but a 429 retried in silence for ever. */}
        {streamsFailing && (
          <StatusDot
            status="warn"
            label="Not receiving finished-job notifications — the connection to the service keeps failing."
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
