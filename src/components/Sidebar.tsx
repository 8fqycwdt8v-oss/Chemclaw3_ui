/**
 * Conversation list: the server's sessions (`GET /sessions`) merged with the local list, so
 * conversations from another device appear; a local title wins. The panel body is shared by the
 * persistent column (>= lg) and the mobile Sheet, so navigation and "Reset app" are always
 * reachable.
 */

import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useLocation, useNavigate } from 'react-router';
import {
  BookOpen,
  FileCheck2,
  FlaskConical,
  GitBranch,
  LogOut,
  MoreHorizontal,
  Plus,
  Search,
  Server,
  Shapes,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import {
  api,
  type SessionPage,
  type SessionSummary,
  type SharedSessionSummary,
} from '../api/client.ts';
import { ApiError } from '../api/errors.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { keys, useApiInfiniteQuery, useApiQuery } from '../api/queryClient.ts';
import { sharedSessionsQuery } from '../api/queries.ts';
import type { AuthProvider } from '../auth/types.ts';
import { useChatStore, newConversation, forgetLocalHistory } from '../state/chatStore.ts';
import type { ChatState } from '../state/chatStore.ts';
import type { Conversation } from '../state/types.ts';
import { announceStatus } from '../state/announce.ts';
import { relativeTime } from '../lib/format.ts';
import { logger } from '../lib/logger.ts';
import { leaveConversation } from './MembersPanel.tsx';
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
 * Fold one page of the service's sessions into the local list (first read and "Load more"). Returns
 * how many were added.
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
      // The service's title (from the first user message); the placeholder is the fallback for
      // older services and sessions nobody has spoken in.
      const named = summary.title?.trim();
      // Sort by last activity (`updated_at`), not by when the session started.
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
 * Fold `GET /sessions/shared` into the local list, marked as somebody else's (`membership`), which
 * files the row under "Shared with me" and hides Branch and Delete. A session already held is
 * marked, not duplicated.
 */
export function adoptShared(remote: SharedSessionSummary[]): void {
  const state = useChatStore.getState();
  const bySession = new Map(
    Object.values(state.conversations)
      .filter((c) => c.sessionId)
      .map((c) => [c.sessionId, c.id] as const),
  );
  const additions: Conversation[] = [];
  for (const summary of remote) {
    const membership = { owner: summary.owner ?? null };
    const known = bySession.get(summary.session_id);
    if (known) {
      state.setMembership(known, membership);
      continue;
    }
    const added = Date.parse(summary.added_at);
    const at = Number.isNaN(added) ? Date.now() : added;
    additions.push({
      ...newConversation(),
      sessionId: summary.session_id,
      title: summary.title?.trim() || 'Shared conversation',
      createdAt: at,
      updatedAt: at,
      sessionOrigin: 'server',
      membership,
    });
  }
  if (additions.length === 0) return;
  useChatStore.setState((s) => ({
    conversations: {
      ...s.conversations,
      ...Object.fromEntries(additions.map((c) => [c.id, c])),
    },
    order: [...s.order, ...additions.map((c) => c.id)],
  }));
}

/**
 * Adopt conversations others let this person into, once per mount; an older service yields none.
 */
function useSharedSessions(): void {
  const { auth, ready } = useAuth();
  const { data } = useApiQuery<SharedSessionSummary[], ApiError>({
    ...sharedSessionsQuery(auth),
    enabled: ready,
  });
  useEffect(() => {
    // Same reading as the plan inbox: a listing that is not a list is nothing shared.
    if (Array.isArray(data)) adoptShared(data);
  }, [data]);
}

/**
 * Pull server-side sessions, paged by `X-Next-Cursor` (the service caps a listing at
 * `service_max_listed_sessions`). The first page loads on mount; more on request.
 */
function useServerSessions(): {
  health: 'idle' | 'degraded';
  more: (() => void) | null;
  loadingMore: boolean;
  /** How the last *next-page* fetch failed, when one did — see `moreFailed` below. */
  moreFailed: 'retry' | 'final' | null;
} {
  const { auth, ready } = useAuth();
  /**
   * The listing as pages; `getNextPageParam` reads the cursor. Disabled until auth resolves (the
   * placeholder provider throws).
   */
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError } =
    useApiInfiniteQuery<SessionPage, ApiError, string>({
      queryKey: keys.sessions,
      queryFn: ({ pageParam }) => api.pageSessions(auth, pageParam || undefined),
      initialPageParam: '',
      getNextPageParam: (page) => page.next || undefined,
      enabled: ready,
    });

  /** Adopt each page as it arrives; idempotent. */
  const pages = data?.pages;
  useEffect(() => {
    if (!pages) return;
    for (const page of pages) adoptSessions(page.sessions);
  }, [pages]);

  // Note when the listing failed (missing route vs refused token look identical otherwise); clears
  // on the next success.
  useEffect(() => {
    if (!error) return;
    logger.warn('sessions.list_failed', {
      kind: error instanceof ApiError ? error.kind : 'unknown',
      ...(error instanceof ApiError && error.status ? { status: error.status } : {}),
    });
  }, [error]);

  /**
   * How the last next-page fetch failed, if it did. `hasNextPage` does not reflect a failed fetch.
   * A non-retryable `ApiError` (e.g. 422 bad cursor) is final and removes the control; a retryable
   * one keeps it. Non-`ApiError` failures count as final.
   */
  const moreFailed: 'retry' | 'final' | null = !isFetchNextPageError
    ? null
    : error instanceof ApiError && error.retryable
      ? 'retry'
      : 'final';

  return {
    // Degraded only when no server page arrived at all.
    health: error && !pages?.length ? 'degraded' : 'idle',
    // Hidden after a final failure; kept after a transient one (pressing again refetches the failed
    // page).
    more: hasNextPage && moreFailed !== 'final' ? () => void fetchNextPage() : null,
    loadingMore: isFetchingNextPage,
    moreFailed,
  };
}

/**
 * Each conversation's searchable text, lowercased, cached per conversation object (replaced only
 * when it changes), so a streaming turn rebuilds one entry per frame. A `WeakMap` evicts exactly
 * when the conversation is gone.
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
 * The conversation ids this panel lists, newest first, filtered by search. Pure, so the
 * subscription can be a shallow-compared array.
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
 * Remove a conversation on the service, then locally. On failure it is reported and kept, so the
 * chemist is never told it is gone when it is not.
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
      // A member cannot delete a shared conversation (403): final, and the message says who can.
      const forbidden = err instanceof ApiError && err.kind === 'forbidden';
      useChatStore.getState().setBanner({
        kind: 'warn',
        text: forbidden
          ? 'Only this conversation’s owner can delete it — it holds other people’s messages too. You can leave it instead.'
          : err instanceof Error
            ? `This conversation was not deleted on the server: ${err.message}`
            : 'This conversation was not deleted on the server.',
        ...(forbidden ? {} : { action: 'retry' as const }),
      });
      return;
    }
  }
  useChatStore.getState().deleteConversation(id);
}

/**
 * Fork onto a new session and open it locally with the parent's messages; `sessionOrigin: 'server'`
 * lets the transcript rehydrate reconcile.
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
        err instanceof ApiError && err.kind === 'forbidden'
          ? 'Only this conversation’s owner can branch it — a branch would copy other people’s messages into a conversation only you own.'
          : err instanceof ApiError && err.status === 409
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
        // `aria-current` marks the active row for assistive tech.
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
        <span className="mt-0.5 block truncate text-2xs text-ink-subtle">
          {relativeTime(conversation.updatedAt)}
          {conversation.membership?.owner && ` · from ${conversation.membership.owner}`}
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
          {/* Somebody else's conversation: Branch and Delete are the owner's (the service refuses a member), so a member is offered Leave. */}
          {conversation.membership && (
            <ConfirmDialog
              trigger={
                <DropdownMenuItem tone="danger" onSelect={(e) => e.preventDefault()}>
                  <LogOut />
                  Leave conversation
                </DropdownMenuItem>
              }
              title="Leave this conversation?"
              description="You will no longer be able to read it or send into it. Only its owner can add you back."
              confirmLabel="Leave"
              variant="destructive"
              onConfirm={() => void leaveConversation(id, auth)}
            />
          )}
          {!conversation.membership && <OwnerActions id={id} auth={auth} navigate={navigate} />}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/** Branch and Delete — the acts that are the conversation owner's alone. */
function OwnerActions({
  id,
  auth,
  navigate,
}: {
  id: string;
  auth: AuthProvider;
  navigate: (to: string) => void | Promise<void>;
}): React.JSX.Element {
  return (
    <>
      {/* Delete removes the conversation on the service, behind a confirmation. `onSelect` is
          prevented so the menu does not unmount the dialog it opens. */}
      {/* Branch keeps both conversations: the service copies the whole thread (refusing
          mid-turn) under a new id. */}
      <DropdownMenuItem
        onSelect={() => {
          // A statement body so the promise is not returned; `forkConversation` reports its own
          // failures.
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
    </>
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
        // The count is in the accessible name, so it is announced with what it counts.
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
  const { health: degraded, more: loadMoreSessions, loadingMore, moreFailed } = useServerSessions();
  // Either this tab or the leader tab hit the stream cap; followers only see the latter.
  const throttled = useChatStore((s) => s.jobStreamsThrottled || s.jobStreamsThrottledElsewhere);
  const streamsFailing = useChatStore((s) => s.jobStreamsFailing.length > 0);
  // A number, not the list: zustand compares with `Object.is`, so subscribing to the array itself
  // would re-render this whole panel on every `syncAwaiting` that changed nothing.
  const awaiting = useChatStore((s) => s.awaiting.length);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();

  // Subscribe to the id list (shallow-compared), not the conversations map, which changes on every
  // token flush; each row subscribes to its own conversation.
  const visible = useChatStore(useShallow((s) => visibleConversationIds(s, needle)));
  // Shared conversations are listed under their own heading.
  const sharedIds = useChatStore(
    useShallow((s) => visible.filter((id) => s.conversations[id]?.membership)),
  );
  const ownIds = useMemo(() => {
    const shared = new Set(sharedIds);
    return visible.filter((id) => !shared.has(id));
  }, [visible, sharedIds]);
  useSharedSessions();

  const open = (id: string): void => {
    // Read at click time, so this panel does not subscribe to the whole map.
    const opened = useChatStore.getState().conversations[id];
    const title = opened?.title ?? 'conversation';
    const count = opened?.messages.length ?? 0;
    void navigate(`/c/${id}`);
    onNavigate?.();
    // Move focus to the transcript and announce what opened.
    document.getElementById('transcript')?.focus({ preventScroll: true });
    announceStatus(`Opened ${title}. ${count} message${count === 1 ? '' : 's'}.`);
  };

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
            // A data attribute, not an `id`: this component renders twice (column and drawer).
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
          {ownIds.map((id) => (
            <ConversationRow key={id} id={id} active={id === activeId} onSelect={() => open(id)} />
          ))}
        </ul>

        {/* A heading within the one "Conversations" navigation, not a second landmark. */}
        {sharedIds.length > 0 && (
          <>
            <h2 className="px-2.5 pt-4 pb-1 text-2xs font-semibold tracking-wide text-ink-subtle uppercase">
              Shared with me
            </h2>
            <ul aria-label="Shared with me" className="space-y-1">
              {sharedIds.map((id) => (
                <ConversationRow
                  key={id}
                  id={id}
                  active={id === activeId}
                  onSelect={() => open(id)}
                />
              ))}
            </ul>
          </>
        )}

        {/* Only when the service advertised another page; hidden during search, which reads only local conversations. */}
        {loadMoreSessions && !needle && (
          <div className="px-1 pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              disabled={loadingMore}
              onClick={loadMoreSessions}
            >
              {/* The label says whether this press is a retry. */}
              {loadingMore
                ? 'Loading…'
                : moreFailed === 'retry'
                  ? 'Retry loading earlier conversations'
                  : 'Load earlier conversations'}
            </Button>
          </div>
        )}

        {/* After a final failure, say the list is incomplete where the control was. */}
        {moreFailed === 'final' && !needle && (
          <div className="px-1 pt-2">
            <StatusDot
              status="warn"
              label="Could not load earlier conversations — the service would not resume this listing. Only the conversations above are shown."
              className="items-start text-2xs leading-snug"
            />
          </div>
        )}
      </nav>

      <div className="space-y-3 border-t border-border-subtle p-3">
        {/* Non-conversation screens, in the footer. */}
        <nav aria-label="Other views" className="flex flex-col gap-1">
          {/* A count on the link: an open question has a deadline in days and must stay visible. */}
          <SidebarLink to="/review" icon={<FileCheck2 />} onNavigate={onNavigate} count={awaiting}>
            Review queue
          </SidebarLink>
          {/* Designs outlive the conversation that drafted them, so they need a way in that is not a session. */}
          <SidebarLink to="/protocols" icon={<FlaskConical />} onNavigate={onNavigate}>
            Experiment protocols
          </SidebarLink>
          {/* Artefacts outlive their conversation too. */}
          <SidebarLink to="/artefacts" icon={<Shapes />} onNavigate={onNavigate}>
            My artefacts
          </SidebarLink>
          <SidebarLink to="/jobs" icon={<Server />} onNavigate={onNavigate}>
            Durable runs
          </SidebarLink>
          {/* Stored skills must be findable so the people they act on can see and remove them. */}
          <SidebarLink to="/skills" icon={<BookOpen />} onNavigate={onNavigate}>
            Skills
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

        {/* Low-key notice: completed-job notifications are failing. */}
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
          description="This clears every conversation stored in this browser and starts fresh. Notices held only in this browser — saved-query findings, check-ins and job completions — are discarded too. Close any other ChemClaw tab first: one left open keeps its copy and writes it back. Server-side sessions are not deleted, but this device will no longer have a link to them."
          confirmLabel="Reset everything"
          variant="destructive"
          // `forgetLocalHistory`, not `clearAll()` alone, or the stored notices would be folded
          // back to disk. This tab only: another open tab may write its copy back.
          onConfirm={forgetLocalHistory}
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
