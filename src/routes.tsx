/**
 * Routing, by path (MSAL's redirect response uses the fragment).
 *
 * - URLs carry the local conversation id (`/c/:id`), not the disposable server session id (see
 *   `src/state/types.ts`).
 * - `/open/:sessionId` adopts a server session into a local conversation and redirects. It is not a
 *   share link: the service 404s non-owners, and members find shared conversations under "Shared
 *   with me". `/s/:sessionId` (old links) renders an explanation and goes nowhere.
 * - `/auth/callback` is MSAL's `redirectUri`; it writes no URL.
 * - No element writes the URL on mount until auth has settled (`useAuth().settled`): MSAL redeems
 *   the code only if the address bar still names the page sign-in started from
 *   (`src/auth/AuthContext.tsx`). `e2e/oidc-mock.spec.ts` counts the navigations.
 */

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router';
import { useChatStore, newConversation } from './state/chatStore.ts';
import { keys, queryClient } from './api/queryClient.ts';
import type { SharedSessionSummary } from './api/client.ts';
import { useAuth } from './auth/AuthContext.tsx';
import { AppShell } from './App.tsx';
import { Loading } from '@/components/chem/Feedback';
import { Button } from '@/components/ui/button';

/**
 * The panels that are not the conversation, each lazily loaded in its own chunk with a named
 * `loader` for prefetching (the `LazyMarkdown.tsx` pattern), so they are off the first-paint path.
 * Code they share with the chat stays in the main bundle.
 */
const loadReviewQueue = () =>
  import('./components/ReviewQueue.tsx').then((m) => ({ default: m.ReviewQueue }));
const loadSkillsPanel = () =>
  import('./components/SkillsPanel.tsx').then((m) => ({ default: m.SkillsPanel }));
const loadJobsPanel = () =>
  import('./components/JobsPanel.tsx').then((m) => ({ default: m.JobsPanel }));
const loadProtocolsPanel = () =>
  import('./components/ProtocolsPanel.tsx').then((m) => ({ default: m.ProtocolsPanel }));
const loadProtocolDocument = () =>
  import('./components/ProtocolDocument.tsx').then((m) => ({ default: m.ProtocolDocument }));
const loadMyExhibits = () =>
  import('./components/exhibits/MyExhibits.tsx').then((m) => ({ default: m.MyExhibits }));

const ReviewQueue = lazy(loadReviewQueue);
const SkillsPanel = lazy(loadSkillsPanel);
const JobsPanel = lazy(loadJobsPanel);
const ProtocolsPanel = lazy(loadProtocolsPanel);
const ProtocolDocument = lazy(loadProtocolDocument);
const MyExhibits = lazy(loadMyExhibits);

let prefetched = false;

/** Warm the panel chunks; idempotent. Called from an idle callback once the app is up. */
export function prefetchPanels(): void {
  if (prefetched) return;
  prefetched = true;
  void Promise.all([
    loadReviewQueue(),
    loadJobsPanel(),
    loadProtocolsPanel(),
    loadProtocolDocument(),
  ]).catch(() => {
    // A warm-up that failed is not an error anybody can act on: the route itself will import
    // again when it is actually navigated to, and *that* failure has a place to be shown.
    prefetched = false;
  });
}

/**
 * A lazily loaded panel with a named fallback, inside `AppShell` so the chrome stays put while it
 * loads.
 */
function Panel({ what, children }: { what: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Suspense fallback={<Loading className="justify-center p-8">{what}</Loading>}>
      {children}
    </Suspense>
  );
}

/** Hold a URL-writing element until auth has settled (see the module docstring). */
function AfterAuth({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { settled } = useAuth();
  if (!settled) return <Loading className="justify-center p-8">Signing in…</Loading>;
  return <>{children}</>;
}

/** Pick a conversation to land on, creating one if the store is empty. */
function Bootstrap(): React.JSX.Element {
  const navigate = useNavigate();
  const { settled } = useAuth();

  // The only place a conversation is created for want of one. Not before auth settles: navigating
  // away from `/` before MSAL redeems the code loops the sign-in, and before then the store holds
  // the anonymous slot.
  useEffect(() => {
    if (!settled) return;
    const state = useChatStore.getState();
    const [first] = state.order;
    const target = first && state.conversations[first] ? first : state.createConversation();
    // `void`: nothing waits on the navigation promise.
    void navigate(`/c/${target}`, { replace: true });
  }, [settled, navigate]);

  return <Loading className="justify-center p-8">Opening…</Loading>;
}

/**
 * Adopt a server session id into a local conversation (`sessionOrigin: 'server'`), then go to
 * `/c/:id`.
 */
function SessionResolver(): React.JSX.Element {
  const { sessionId = '' } = useParams();
  const navigate = useNavigate();
  const { auth, ready, settled } = useAuth();
  // The backend's session ids are 32 lowercase hex characters (`shared/events.ts`), so anything
  // else is a mistyped or truncated link rather than a session we have not seen.
  const valid = /^[0-9a-f]{32}$/.test(sessionId);
  // Signed out under Entra on an `/open/` link: sign in from here, so the adoption runs in the
  // user's own slot after the redirect returns to this path.
  const mustSignIn = valid && ready && auth.mode === 'msal' && !auth.account;
  const signingIn = useRef(false);
  // A sign-in that could not start is shown with a way to retry, not left on "Signing in…".
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!mustSignIn || signingIn.current) return;
    // Once per attempt: StrictMode runs effects twice, and a second `loginRedirect` while the first
    // is navigating fails with `interaction_in_progress`.
    signingIn.current = true;
    auth.login().catch((err: unknown) => {
      signingIn.current = false;
      setFailure(err instanceof Error && err.message ? err.message : 'Sign-in could not start.');
    });
  }, [mustSignIn, auth, attempt]);

  useEffect(() => {
    // Not before auth has settled: this page can be where a sign-in returns to, and MSAL redeems
    // the code only while the address bar still names it (see the module docstring).
    if (!valid || !settled || mustSignIn) return;
    const state = useChatStore.getState();
    const existing = Object.values(state.conversations).find((c) => c.sessionId === sessionId);
    if (existing) {
      void navigate(`/c/${existing.id}`, { replace: true });
      return;
    }
    // A session somebody else let this person into opens as shared (from the cached shared
    // listing).
    const shared = queryClient
      .getQueryData<SharedSessionSummary[]>(keys.sharedSessions)
      ?.find((row) => row.session_id === sessionId);
    const conversation = {
      ...newConversation(),
      sessionId,
      title: shared
        ? shared.title?.trim() || 'Shared conversation'
        : 'Conversation from another device',
      // The transcript lives on the backend, so the rehydrate effect should go and read it.
      sessionOrigin: 'server' as const,
      ...(shared ? { membership: { owner: shared.owner ?? null } } : {}),
    };
    useChatStore.setState((s) => ({
      conversations: { ...s.conversations, [conversation.id]: conversation },
      order: [conversation.id, ...s.order],
    }));
    void navigate(`/c/${conversation.id}`, { replace: true });
  }, [sessionId, valid, settled, mustSignIn, navigate]);

  if (!valid) {
    return (
      <AppShell>
        <NotFound
          title="That link doesn’t look like a conversation"
          detail="A conversation link ends in a 32-character session id. Check it was copied whole."
        />
      </AppShell>
    );
  }
  if (mustSignIn && failure !== null) {
    // Not inside `AppShell`: the shell's panels fetch on mount, and every fetch while signed out
    // starts a sign-in of its own — the very thing that just failed.
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div
          role="alert"
          className="max-w-md rounded-xl border border-border-subtle bg-surface-raised p-5 shadow-sm"
        >
          <h2 className="font-semibold">Couldn’t start signing in</h2>
          <p className="mt-1.5 text-sm text-ink-muted">
            This link opens a conversation once you are signed in. {failure}
          </p>
          <div className="mt-4">
            <Button
              size="sm"
              onClick={() => {
                setFailure(null);
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <Loading className="justify-center p-8">
      {mustSignIn ? 'Signing in to open the conversation…' : 'Opening the conversation…'}
    </Loading>
  );
}

/**
 * The MSAL landing path: waits for `handleRedirectPromise()` (already in flight) to settle, then
 * leaves for `/`. Must not touch the URL before then.
 */
function AuthCallback(): React.JSX.Element {
  const { settled } = useAuth();
  if (!settled) return <Loading className="justify-center p-8">Completing sign-in…</Loading>;
  return <Navigate to="/" replace />;
}

export function NotFound({
  title = 'That conversation isn’t on this device',
  detail = 'Conversations live in this browser, so a link only opens one on the machine that created it. This app also keeps the 30 most recent, so an older one may have been trimmed.',
}: {
  title?: string;
  detail?: string;
}): React.JSX.Element {
  const navigate = useNavigate();
  const order = useChatStore((s) => s.order);

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-md rounded-xl border border-border-subtle bg-surface-raised p-5 shadow-sm">
        <h2 className="font-semibold">{title}</h2>
        <p className="mt-1.5 text-sm text-ink-muted">{detail}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {order[0] && (
            <Button size="sm" onClick={() => void navigate(`/c/${order[0]}`)}>
              Open the most recent
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void navigate(`/c/${useChatStore.getState().createConversation()}`)}
          >
            Start a new conversation
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The app proper, for one conversation. Owns the sync between the URL and the store. */
function ConversationRoute(): React.JSX.Element {
  const { conversationId = '' } = useParams();
  const navigate = useNavigate();
  // Not subscribed to `activeId`: this route follows the URL.
  const known = useChatStore((s) => Boolean(s.conversations[conversationId]));

  // The URL is the source of truth for *which* conversation, and this is the one place that
  // follows it. The identity guard makes a redundant call cheap rather than merely tidy.
  useEffect(() => {
    if (!known) return;
    if (useChatStore.getState().activeId === conversationId) return;
    useChatStore.getState().selectConversation(conversationId);
  }, [conversationId, known]);

  // Navigate away only when the displayed conversation disappears (deleted or reset); deliberate
  // moves navigate from their own handlers. A general store→URL mirror would fight Back.
  // `displayed` distinguishes "gone while open" (follow the store) from "never on this device"
  // (stay and say so).
  const displayed = useRef<string | null>(null);
  useEffect(() => {
    if (known) displayed.current = conversationId;
  }, [known, conversationId]);

  useEffect(() => {
    if (known || displayed.current !== conversationId) return;
    const current = useChatStore.getState().activeId;
    if (!current || current === conversationId) return;
    // `replace`, so a deletion does not leave a dead entry for Back to land on.
    void navigate(`/c/${current}`, { replace: true });
  }, [known, conversationId, navigate]);

  if (!known) return <AppShell>{<NotFound />}</AppShell>;
  return <AppShell conversationId={conversationId} />;
}

export function AppRoutes(): React.JSX.Element {
  // Prefetch panel chunks when idle after first paint (`setTimeout` fallback for Safari).
  useEffect(() => {
    const idle = window.requestIdleCallback;
    if (idle) {
      const handle = idle.call(window, prefetchPanels);
      return () => window.cancelIdleCallback(handle);
    }
    const timer = setTimeout(prefetchPanels, 2_000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <Routes>
      <Route path="/" element={<Bootstrap />} />
      <Route path="/c/:conversationId" element={<ConversationRoute />} />
      <Route path="/open/:sessionId" element={<SessionResolver />} />
      {/* Non-conversation screens render inside the shell, so Back returns to the conversation. */}
      {/* `/jobs/:jobId` opens the jobs panel with one run expanded, so an operator can be sent to a run. The panel reads the parameter itself. */}
      <Route
        path="/review"
        element={
          <AppShell>
            <Panel what="Opening the review queue…">
              <ReviewQueue />
            </Panel>
          </AppShell>
        }
      />
      {/* Stored skills, so the people they act on can see and remove them. */}
      <Route
        path="/skills"
        element={
          <AppShell>
            <Panel what="Opening the skills screen…">
              <SkillsPanel />
            </Panel>
          </AppShell>
        }
      />
      <Route
        path="/jobs"
        element={
          <AppShell>
            <Panel what="Opening the jobs list…">
              <JobsPanel />
            </Panel>
          </AppShell>
        }
      />
      <Route
        path="/jobs/:jobId"
        element={
          <AppShell>
            <Panel what="Opening the run…">
              <JobsPanel />
            </Panel>
          </AppShell>
        }
      />
      {/* The protocol list and one document; the document reads its own `:designId` so links and reloads land on it. */}
      <Route
        path="/protocols"
        element={
          <AppShell>
            <Panel what="Opening the protocols…">
              <ProtocolsPanel />
            </Panel>
          </AppShell>
        }
      />
      <Route
        path="/protocols/:designId"
        element={
          <AppShell>
            <Panel what="Opening the protocol…">
              <ProtocolDocument />
            </Panel>
          </AppShell>
        }
      />
      {/* Every artefact of the reader's, across conversations. Not a conversation, so it renders
          inside the shell with none; a row opens its conversation through `/open/:sessionId`. */}
      <Route
        path="/artefacts"
        element={
          <AppShell>
            <Panel what="Opening your artefacts…">
              <MyExhibits />
            </Panel>
          </AppShell>
        }
      />
      <Route path="/auth/callback" element={<AuthCallback />} />
      {/* Old `/s/` links: explain and go nowhere. Not a redirect (this was never a share link), and not the catch-all, which would mint an empty conversation. */}
      <Route
        path="/s/:sessionId"
        element={
          <AppShell>
            <NotFound
              title="That link has moved"
              detail="Conversation links start with /open/ now — the 32-character session id at the end is unchanged. They open a conversation on another of your own devices, or one its owner has added you to — the service serves a conversation to nobody else."
            />
          </AppShell>
        }
      />
      <Route
        path="*"
        element={
          <AfterAuth>
            <Navigate to="/" replace />
          </AfterAuth>
        }
      />
    </Routes>
  );
}
