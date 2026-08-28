/**
 * Routing.
 *
 * Paths, never a hash. MSAL's redirect response *is* a URL fragment (`src/auth/msalAuth.ts`), so a
 * hash router would be fighting it for the same characters.
 *
 * The URL carries the LOCAL conversation id, not the server session id. `src/state/types.ts`
 * explains why the two exist: the session handle is disposable — evictable from a backend LRU,
 * replaced on `session_not_found` and on reset — while the local id owns the transcript and never
 * changes. A URL keyed on the session id would go dead when the backend rotates it, and would
 * change under the person who shared it, mid-conversation.
 *
 * `/s/:sessionId` exists anyway, as a resolver rather than a destination: it adopts a server
 * session into a local conversation and redirects to `/c/<local>`. That makes a link portable
 * between devices right up until the backend rotates the session, which is the honest limit of
 * what this data model can back. See the note in ISSUES.md.
 *
 * `/auth/callback` is reserved by MSAL's `redirectUri` and is already SPA-fallbacked by `sirv`
 * (`server/index.ts`). Its element writes no URL — and the URL-sync effects live INSIDE the
 * `/c/:id` element rather than being guarded by a pathname check, so they structurally cannot run
 * while a redirect fragment is still on the address bar.
 */

import { useEffect, useRef } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router';
import { useChatStore, newConversation } from './state/chatStore.ts';
import { useAuth } from './auth/AuthContext.tsx';
import { AppShell } from './App.tsx';
import { ReviewQueue } from './components/ReviewQueue.tsx';
import { JobsPanel } from './components/JobsPanel.tsx';
import { Loading } from '@/components/chem/Feedback';
import { Button } from '@/components/ui/button';

/** Pick a conversation to land on, creating one if the store is empty. */
function Bootstrap(): React.JSX.Element {
  const navigate = useNavigate();

  // The only place a conversation is created for want of one. It used to live in `App`, where
  // under a router it would fire behind the not-found panel and rewrite the URL out from under
  // the reader before they could read it.
  useEffect(() => {
    const state = useChatStore.getState();
    const [first] = state.order;
    const target = first && state.conversations[first] ? first : state.createConversation();
    // `void`: react-router's `navigate` returns a promise that settles when the transition
    // does, and nothing here waits for it. Marked rather than left floating so the lint rule
    // that now exists can tell this from a promise somebody forgot.
    void navigate(`/c/${target}`, { replace: true });
  }, [navigate]);

  return <Loading className="justify-center p-8">Opening…</Loading>;
}

/**
 * Adopt a server session id into a local conversation, then hand off to `/c/:id`.
 *
 * Reuses the shape `useServerSessions` already uses for a session it did not know about: a local
 * conversation carrying the session id, with `sessionOrigin: 'server'` so the transcript rehydrate
 * in `App` knows to pull its messages.
 */
function SessionResolver(): React.JSX.Element {
  const { sessionId = '' } = useParams();
  const navigate = useNavigate();
  // The backend's session ids are 32 lowercase hex characters (`shared/events.ts`), so anything
  // else is a mistyped or truncated link rather than a session we have not seen.
  const valid = /^[0-9a-f]{32}$/.test(sessionId);

  useEffect(() => {
    if (!valid) return;
    const state = useChatStore.getState();
    const existing = Object.values(state.conversations).find((c) => c.sessionId === sessionId);
    if (existing) {
      void navigate(`/c/${existing.id}`, { replace: true });
      return;
    }
    const conversation = {
      ...newConversation(),
      sessionId,
      title: 'Shared conversation',
      // The transcript lives on the backend, so the rehydrate effect should go and read it.
      sessionOrigin: 'server' as const,
    };
    useChatStore.setState((s) => ({
      conversations: { ...s.conversations, [conversation.id]: conversation },
      order: [conversation.id, ...s.order],
    }));
    void navigate(`/c/${conversation.id}`, { replace: true });
  }, [sessionId, valid, navigate]);

  if (!valid) {
    return (
      <AppShell>
        <NotFound
          title="That link doesn’t look like a conversation"
          detail="A shared link ends in a 32-character session id. Check it was copied whole."
        />
      </AppShell>
    );
  }
  return <Loading className="justify-center p-8">Opening the shared conversation…</Loading>;
}

/**
 * The MSAL landing path.
 *
 * `handleRedirectPromise()` consumes the fragment during `createAuthProvider()`, which is already
 * in flight from module scope. This waits for that to settle and then leaves. It must not touch
 * the URL before then.
 */
function AuthCallback(): React.JSX.Element {
  const { ready } = useAuth();
  if (!ready) return <Loading className="justify-center p-8">Completing sign-in…</Loading>;
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
  // Deliberately not subscribed to `activeId`: this route follows the URL, and reading the store's
  // idea of "active" for rendering is what invites the two to disagree. The reconciler below reads
  // it fresh, at the one moment it matters.
  const known = useChatStore((s) => Boolean(s.conversations[conversationId]));

  // The URL is the source of truth for *which* conversation, and this is the one place that
  // follows it. The identity guard makes a redundant call cheap rather than merely tidy.
  useEffect(() => {
    if (!known) return;
    if (useChatStore.getState().activeId === conversationId) return;
    useChatStore.getState().selectConversation(conversationId);
  }, [conversationId, known]);

  // The URL only ever moves back the other way when the conversation it names has *disappeared* —
  // the reader deleted the one they were looking at, or reset the app. Every deliberate move
  // (a sidebar row, New conversation, the panel's buttons) navigates from its own handler, so
  // this is a reconciler of last resort, not a mirror.
  //
  // Writing it as a general `activeId !== conversationId → navigate` mirror is the obvious shape
  // and it deadlocks the Back button: the browser rewinds the URL, the effect above selects the
  // older conversation, and this effect runs in the same pass still closed over the *newer*
  // `activeId`, so it navigates forward again — then the same thing happens in reverse, forever.
  // An e2e run caught exactly that, alternating between two conversations until the test gave up.
  //
  // `displayed` separates the two ways a conversation can be missing. Gone-while-open should
  // follow the store; a link to an id this device never had must stay on the panel that says so,
  // rather than being bounced to whatever else happens to be open.
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
  return (
    <Routes>
      <Route path="/" element={<Bootstrap />} />
      <Route path="/c/:conversationId" element={<ConversationRoute />} />
      <Route path="/s/:sessionId" element={<SessionResolver />} />
      {/* Neither is a conversation, so both render inside the shell with no conversation: the
          sidebar, the top bar and the banner stay where they are, and Back returns to the thread
          the reader came from. */}
      <Route
        path="/review"
        element={
          <AppShell>
            <ReviewQueue />
          </AppShell>
        }
      />
      <Route
        path="/jobs"
        element={
          <AppShell>
            <JobsPanel />
          </AppShell>
        }
      />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
