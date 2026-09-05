/**
 * The application shell.
 *
 * Rendered by a route rather than mounted directly, so it takes the conversation to show rather
 * than reading `activeId` for itself. `children` is the escape hatch the not-found panel uses to
 * appear inside the normal chrome instead of replacing it.
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
import { EntityRail } from './components/EntityRail.tsx';
// The transcript→messages mapping used to be inline here (which is why this file imported
// `ChatMessage`); it moved to its own module so it could be tested against real backend payloads
// rather than only through a rendered shell.
import { transcriptToMessages } from './state/transcript.ts';
import { resumeInterruptedTurn } from './state/sendMessage.ts';

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
 * Pull a transcript the server has but this browser does not.
 *
 * Guarded on `sessionOrigin === 'server'`. A session id alone is not enough: `warmSession` gives a
 * brand-new local conversation a session before its first message, which is exactly this guard's
 * other conditions, and reading `/messages` for it would be a wasted round-trip that raises a warn
 * banner if it fails.
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
      // `getMessages` swallows only `session_not_found`; a 401, a 500 or a dropped connection all
      // rethrow. Unhandled, that surfaced as an empty conversation with no explanation and no way
      // to retry — the reader could not tell "nothing was said yet" from "we could not load it".
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
      // The plan is session state the transcript does not carry — `latestPlan` was stream-only,
      // so a reload dropped the checklist while the session was still proposing (and possibly
      // still blocked on) a plan. Read it back *before* hydrating: hydration raises
      // `messageCount`, which re-runs this effect and flips `cancelled` on this continuation,
      // so a read placed after it would always be discarded. Silent on any failure: an older
      // service has no plan route, and a session with no plan is the ordinary case, not an
      // error worth a banner.
      let plan: { todos: string[]; hash: string; awaitingApproval: boolean } | null = null;
      try {
        const status = await api.getPlan(sessionId, auth);
        // `approved` is the EFFECTIVE state — the route folds `consumed_at` in, so a plan that was
        // approved and whose approval has since been spent comes back false, which is exactly when
        // the chemist owes another decision. Carried rather than dropped: without it the checklist
        // returned and the decision it was blocked on did not.
        if (status.plan.length > 0) {
          plan = {
            todos: status.plan,
            hash: status.plan_hash,
            awaitingApproval: !status.approved,
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
          .attachPlan(conversationId, plan.todos, plan.hash, plan.awaitingApproval);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, sessionId, messageCount, fromServer, auth, ready, nonce]);
}

/**
 * Pick up an answer a reload interrupted, for the conversation on screen.
 *
 * Separate from `useRemoteTranscript` because it is a different question with a different
 * precondition. That effect asks "does this conversation have a history I have not read?" and
 * refuses to run once the conversation has any local message at all — which is what made it blind
 * to this case, where the conversation is full and one message in it is a hole. This one asks "is
 * the newest turn a turn that was cut off by a reload, and did the server finish it?".
 *
 * Keyed on the conversation and torn down on navigation, so switching away stops the poll.
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
 * Claim the standing-query digests, once per page.
 *
 * At the top of the app rather than on `/review`, and the reason is the service's own contract:
 * `GET /digests` is a **destructive claim** — a row it returns is marked consumed and is never
 * re-delivered. So this has to happen somewhere that is mounted for the life of the session and
 * that writes straight into the persisted store. Reading it from the screen that displays it would
 * destroy a digest for anyone who opened that screen and navigated away before the response
 * landed.
 *
 * Once, not on an interval. A digest is produced at most once per subscription per day; polling it
 * would be a claim per poll against a mailbox that is usually empty, and the one thing worse than
 * not seeing a digest is claiming one into a page that is closing.
 */
/**
 * Whether this page has already claimed its digests — module scope, not a ref.
 *
 * **A ref made "once per page" false.** `AppShell` is remounted whenever the route *shape* changes:
 * `/c/:id` renders it through `ConversationRoute` while `/review`, `/jobs` and `/protocols` render
 * it directly, so React reconciles a different component at that position and the ref goes with it.
 * Measured over four navigations: `GET /digests` was claimed 4 times, and that route is a
 * *destructive* claim whose rows are never re-delivered. Rows still landed (the `.then` writes
 * through `getState()`), so this was not loss — it was N unbounded windows in which a claim can be
 * in flight when the tab closes, where the docstring above argues for exactly one.
 *
 * `routes.tsx` already uses this shape for its prefetch latch.
 */
let digestsClaimed = false;

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
        // The latch stays closed: retrying on the next render is how a flapping network turns one
        // mailbox read into many. But **not silent** — `logger.debug` is below the shipped
        // `CLIENT_LOG_LEVEL` of `info`, and "a failed claim consumed nothing" is only true of a
        // request that never reached the service. A claim that committed server-side and then lost
        // its response has consumed rows that are now delivered to nobody, with no record anywhere.
        logger.warn('digests.claim_failed', {});
      });
  }, [auth, ready]);
}

/** Whether this page has already read `GET /pending` for the badge. Module scope for the reason
 *  `digestsClaimed` is — a ref does not survive the shell being reconciled at a new route shape. */
let awaitingRead = false;

/**
 * Fill the review badge from the service, once per page.
 *
 * **The badge was 0 after every reload, and stayed 0 until somebody opened `/review`.** `awaiting`
 * is a notification cache fed by `awaiting_answer` frames, and deliberately not persisted — a
 * persisted copy would outlive the answer. But the claim behind those frames is destructive and
 * at-most-once, so a reload does not replay them: the questions are still open, `GET /pending`
 * still lists them, and the one surface that says so is the screen a chemist only opens because
 * the badge told them to. That is the failure this whole path exists to end, arriving by the one
 * route the design left open.
 *
 * So the read that reconciles the cache happens here as well as in `ReviewQueue`, and `/pending` is
 * an ordinary GET rather than a claim — reading it twice costs a request and destroys nothing,
 * which is exactly why `useDigests` above cannot be written this way.
 *
 * The latch is released on failure, unlike the digest one: a retry here is free, and a badge that
 * reads 0 for the life of the page because one request lost its connection is the defect again.
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
        // **`getElementById` returns the first match, and there are two.** `SidebarBody` renders
        // in both the always-mounted `lg:flex` column and the mobile drawer, so below `lg` the
        // first match is inside a `display:none` subtree where `.focus()` is a no-op — the
        // shortcut did nothing on exactly the bench tablets it was for. Query every copy and take
        // the one that can actually take focus (`offsetParent` is null for a hidden element).
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
  useDigests();
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
        {/* The rail is a sibling of <main>, not a child of it: it indexes the conversation rather
            than being part of the document the reader is reading, and a landmark inside another
            landmark is not what "skip to the transcript" should land in. It takes the same
            `conversationId` the transcript does, from the same route parameter, which is what
            makes it structurally impossible for the two to describe different conversations. */}
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
          {conversationId && !children && <EntityRail conversationId={conversationId} />}
        </div>
      </div>
    </div>
  );
}
