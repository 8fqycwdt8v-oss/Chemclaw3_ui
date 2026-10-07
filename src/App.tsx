/**
 * The application shell, rendered by a route with the conversation to show. `children` lets the
 * not-found panel appear inside the normal chrome.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { configProblems } from './env.ts';
import { useAuth } from './auth/AuthContext.tsx';
import { useChatStore } from './state/chatStore.ts';
import { api } from './api/client.ts';
import { logger } from './lib/logger.ts';
import { useJobStreams } from './hooks/useJobStreams.ts';
import { useJobNotifications } from './hooks/useJobNotifications.ts';
import { useVisualViewport } from './hooks/useVisualViewport.ts';
import { useShortcuts, type Shortcut } from './hooks/useShortcuts.ts';
import { ShortcutSheet } from './components/ShortcutSheet.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { TopBar } from './components/TopBar.tsx';
import { MessageList } from './components/MessageList.tsx';
import { JobFeed } from './components/JobFeed.tsx';
import { Composer } from './components/Composer.tsx';
import { RightColumn } from './components/exhibits/RightColumn.tsx';
// The transcript→messages mapping lives in its own module, tested against real payloads.
import { transcriptToMessages } from './state/transcript.ts';
import { resumeInterruptedTurn } from './state/sendMessage.ts';
import { followSharedConversation } from './state/sharedSync.ts';
import { useMembers } from './components/MembersPanel.tsx';

function ConfigError({ problems }: { problems: string[] }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md rounded-xl border border-danger/40 bg-danger-soft p-5 shadow-sm">
        <h1 className="mb-2 font-semibold text-danger-ink">Configuration error</h1>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-ink-muted">
          These come from the UI server’s environment and are served at <code>/config.js</code>.
        </p>
      </div>
    </div>
  );
}

/**
 * Pull a transcript the server has and this browser does not. Only for `sessionOrigin === 'server'`
 * (a warmed local session has nothing to read).
 *
 * Not a `useQuery`: it is an ordered procedure — the plan is read back before hydrating, because
 * hydrating changes `messageCount`, one of this hook's own guards — and its failure path writes a
 * banner to the store.
 */
function useRemoteTranscript(conversationId: string | undefined, nonce: number): void {
  const { auth, ready } = useAuth();
  const sessionId = useChatStore((s) =>
    conversationId ? (s.conversations[conversationId]?.sessionId ?? null) : null,
  );
  const messageCount = useChatStore((s) =>
    conversationId ? (s.conversations[conversationId]?.messages.length ?? 0) : 0,
  );
  const fromServer = useChatStore((s) =>
    conversationId ? s.conversations[conversationId]?.sessionOrigin === 'server' : false,
  );

  useEffect(() => {
    if (!ready || !conversationId || !sessionId || messageCount > 0 || !fromServer) return;
    let cancelled = false;
    void (async () => {
      // Only `session_not_found` is swallowed; other failures get a banner and a retry.
      let remote: Awaited<ReturnType<typeof api.getMessages>>;
      try {
        remote = await api.getMessages(sessionId, auth);
      } catch (err) {
        if (!cancelled) {
          useChatStore.getState().setBanner({
            kind: 'warn',
            text:
              err instanceof Error
                ? `Could not load this conversation’s earlier messages: ${err.message}`
                : 'Could not load this conversation’s earlier messages.',
            action: 'retry',
          });
        }
        return;
      }
      if (cancelled || remote.length === 0) return;
      const messages = transcriptToMessages(remote);
      if (messages.length === 0) return;
      // Read the plan back before hydrating (hydration re-runs this effect and cancels this
      // continuation). Silent on failure: older services have no plan route and most sessions have
      // no plan.
      let plan: {
        todos: string[];
        hash: string;
        awaitingApproval: boolean;
        scope: string[] | null;
        author: string | null;
      } | null = null;
      try {
        const status = await api.getPlan(sessionId, auth);
        // `approved` is the effective state (a spent approval reads false), so the decision card is
        // restored when one is owed.
        if (status.plan.length > 0) {
          plan = {
            todos: status.plan,
            hash: status.plan_hash,
            awaitingApproval: !status.approved,
            // The same payload names what an approval authorizes, and dropping it cost the card a
            // second read of this route on every reload. Absent from an older service: unknown.
            scope: status.scope ?? null,
            // Whose turn wrote it; `null` leaves the decision with the owner.
            author: status.author ?? null,
          };
        }
      } catch {
        // No plan to restore; the checklist simply stays absent.
      }
      if (cancelled) return;
      useChatStore.getState().hydrateTranscript(conversationId, messages);
      if (plan) {
        useChatStore
          .getState()
          .attachPlan(
            conversationId,
            plan.todos,
            plan.hash,
            plan.awaitingApproval,
            plan.scope,
            plan.author,
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, sessionId, messageCount, fromServer, auth, ready, nonce]);
}

/**
 * Pick up an answer a reload interrupted, for the conversation on screen. Separate from
 * `useRemoteTranscript`, which runs only for an empty conversation. Torn down on navigation.
 */
function useResumeInterruptedTurn(conversationId: string | undefined): void {
  const { auth, ready } = useAuth();
  // A boolean, not the message: this must fire when a conversation *acquires* an interrupted turn
  // (a reload, or switching into one) and never again on the token flushes that follow.
  const interrupted = useChatStore((s) =>
    conversationId
      ? (s.conversations[conversationId]?.messages.some(
          (m) => m.role === 'assistant' && m.interruptedByReload,
        ) ?? false)
      : false,
  );

  useEffect(() => {
    if (!ready || !conversationId || !interrupted) return;
    return resumeInterruptedTurn(conversationId, auth);
  }, [auth, ready, conversationId, interrupted]);
}

/**
 * How long the shell trusts an owned conversation's roster; the people panel invalidates it on
 * change.
 */
const ROSTER_STALE_MS = 60_000;

/**
 * Keep a shared conversation in step with the other people in it (`followSharedConversation`); this
 * decides only whether to run. Shared means: this person is a member, or the owner and the roster
 * names someone else (read only once the conversation has messages, under the people panel's key).
 */
function useSharedConversationSync(conversationId: string | undefined): void {
  const { auth, ready } = useAuth();
  const sessionId = useChatStore((s) =>
    conversationId ? (s.conversations[conversationId]?.sessionId ?? null) : null,
  );
  const member = useChatStore((s) =>
    conversationId ? Boolean(s.conversations[conversationId]?.membership) : false,
  );
  const spoken = useChatStore((s) =>
    conversationId ? (s.conversations[conversationId]?.messages.length ?? 0) > 0 : false,
  );
  const roster = useMembers(
    conversationId ?? '',
    sessionId,
    Boolean(conversationId) && !member && spoken,
    ROSTER_STALE_MS,
  );
  const shared = member || (roster.data?.members.length ?? 0) > 0;

  useEffect(() => {
    if (!ready || !conversationId || !sessionId || !shared) return;
    return followSharedConversation(conversationId, auth);
  }, [auth, ready, conversationId, sessionId, shared]);
}

/**
 * Whether this page has claimed its digests. Module scope, not a ref: `AppShell` remounts when the
 * route shape changes, and a ref would claim again each time.
 */
let digestsClaimed = false;

/**
 * Claim the standing-query digests once per page, at the top of the app, straight into the
 * persisted store: `GET /digests` is a destructive claim, so it must not run from a screen the
 * reader may leave before the response lands. Not polled.
 */
function useDigests(): void {
  const { auth, ready } = useAuth();

  useEffect(() => {
    if (!ready || digestsClaimed) return;
    // Latched *before* the request, not after: StrictMode invokes this effect twice in
    // development, and a second claim would consume rows the first one is still carrying.
    digestsClaimed = true;
    void api
      .listDigests(auth)
      .then((digests) => useChatStore.getState().addDigests(digests))
      .catch(() => {
        // The latch stays closed (no retry loop), but warn: a committed claim whose response was
        // lost consumed rows nobody received.
        logger.warn('digests.claim_failed', {});
      });
  }, [auth, ready]);
}

/**
 * Claim this chemist's own blocked work (check-ins) once per page — the same destructive mailbox as
 * digests. A failure is recorded in the store, so the review page never says "nothing is blocked"
 * unless the service said so.
 */
let checkInsClaimed = false;

function useCheckIns(): void {
  const { auth, ready } = useAuth();

  useEffect(() => {
    if (!ready || checkInsClaimed) return;
    // Latched before the request, for `useDigests`'s reason: a StrictMode double-invoke would
    // otherwise consume rows the first claim is still carrying.
    checkInsClaimed = true;
    void api
      .listCheckIns(auth)
      .then((rows) => {
        // `absent` is a 404: this deployment's service does not serve the mailbox at all, which
        // is not the same statement as an empty one and must not render as good news.
        if (rows === 'absent') useChatStore.getState().markCheckInsAbsent();
        else useChatStore.getState().addCheckIns(rows);
      })
      .catch(() => {
        // The latch stays closed — a retry loop against a destructive mailbox is how one claim
        // becomes many — and the store carries the failure to the surface.
        useChatStore.getState().failCheckInClaim();
        logger.warn('check_ins.claim_failed', {});
      });
  }, [auth, ready]);
}

/** Whether this page has already read `GET /pending` for the badge. Module scope for the reason
 *  `digestsClaimed` is — a ref does not survive the shell being reconciled at a new route shape. */
let awaitingRead = false;

/**
 * Fill the review badge from `GET /pending` once per page: the stream's claim is destructive, so a
 * reload replays no frames. A plain GET, so the latch is released on failure.
 */
function useAwaitingBadge(): void {
  const { auth, ready } = useAuth();

  useEffect(() => {
    if (!ready || awaitingRead) return;
    awaitingRead = true;
    void api
      .listPendingRequests(auth)
      .then((next) => {
        useChatStore
          .getState()
          .syncAwaiting(
            next.requests.filter((r) => r.state === 'waiting').map((r) => r.request_id),
          );
      })
      .catch(() => {
        awaitingRead = false;
        logger.warn('pending.read_failed', {});
      });
  }, [auth, ready]);
}

export function AppShell({
  conversationId,
  children,
}: {
  conversationId?: string;
  /** Rendered in place of the transcript — the not-found panel, inside the normal chrome. */
  children?: React.ReactNode;
}): React.JSX.Element {
  const [rehydrateNonce, setRehydrateNonce] = useState(0);
  const [showingShortcuts, setShowingShortcuts] = useState(false);
  const navigate = useNavigate();

  // Held in a memo so the listener is bound once rather than on every render of the shell.
  const shortcuts = useMemo<Shortcut[]>(
    () => [
      {
        key: 'k',
        mod: true,
        label: 'New conversation',
        run: () => {
          const id = useChatStore.getState().createConversation();
          void navigate(`/c/${id}`);
        },
      },
      {
        key: '/',
        mod: true,
        label: 'Search conversations',
        // Two copies of the sidebar exist (column and drawer); focus the one that is visible
        // (`offsetParent`).
        run: () => {
          const boxes = Array.from(
            document.querySelectorAll<HTMLInputElement>('[data-conversation-search]'),
          );
          (boxes.find((box) => box.offsetParent !== null) ?? boxes[0])?.focus();
        },
      },
      {
        key: 'j',
        mod: true,
        label: 'Write a message',
        run: () => document.getElementById('composer')?.focus(),
      },
      {
        key: '?',
        shift: true,
        label: 'Show this list',
        run: () => setShowingShortcuts(true),
      },
    ],
    [navigate],
  );
  useShortcuts(shortcuts);

  useVisualViewport();
  useRemoteTranscript(conversationId, rehydrateNonce);
  useResumeInterruptedTurn(conversationId);
  useSharedConversationSync(conversationId);
  useDigests();
  useCheckIns();
  useAwaitingBadge();
  // Watches several conversations, not just this one: a job launched in one and completing while
  // the chemist reads another is the case the feature exists for.
  useJobStreams();
  // Title badge, and a notification if they opted in. A completion that lands while the tab is
  // backgrounded is the case this whole path exists for.
  useJobNotifications();

  // What the banner's Retry does: clear it and let the transcript read run again.
  const onRetry = useCallback(() => {
    useChatStore.getState().setBanner(null);
    setRehydrateNonce((n) => n + 1);
  }, []);

  const problems = configProblems();
  if (problems.length > 0) return <ConfigError problems={problems} />;

  return (
    <div className="flex h-full">
      <ShortcutSheet
        shortcuts={shortcuts}
        open={showingShortcuts}
        onOpenChange={setShowingShortcuts}
      />
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onRetry={onRetry} conversationId={children ? undefined : conversationId} />
        {/* The rail is a sibling of <main>, not inside it, and takes the same `conversationId` as the transcript. */}
        <div className="flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col">
            {children ??
              (conversationId && (
                <>
                  {/* Keyed so switching conversations resets the window, the scroll pin and the
                      scroll position together, rather than three effects racing to do it. */}
                  <MessageList key={conversationId} conversationId={conversationId} />
                  <JobFeed />
                  <Composer conversationId={conversationId} />
                </>
              ))}
          </main>
          {/* The rail, or the artefact pane holding it as its Index tab; still a sibling of <main>. */}
          {conversationId && !children && <RightColumn conversationId={conversationId} />}
        </div>
      </div>
    </div>
  );
}
