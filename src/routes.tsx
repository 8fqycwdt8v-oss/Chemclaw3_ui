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

import { lazy, Suspense, useEffect, useRef } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router';
import { useChatStore, newConversation } from './state/chatStore.ts';
import { useAuth } from './auth/AuthContext.tsx';
import { AppShell } from './App.tsx';
import { Loading } from '@/components/chem/Feedback';
import { Button } from '@/components/ui/button';

/**
 * The four panels that are not the conversation, each behind its own chunk.
 *
 * They were static imports, so every chemist paid for the review queue, the jobs list, the
 * protocol list and the protocol document in the entry bundle — on the first paint of a fresh
 * conversation, before anything is on screen — and most chemists open none of them. The pattern is
 * `LazyMarkdown.tsx`'s, for the same reason and with the same two halves: a named `loader` so the
 * chunk can be warmed deliberately, and a Suspense fallback honest enough that the wait reads as a
 * wait rather than as a broken page.
 *
 * **Measured on 2026-09-05 with `npm run build:client`, on one tree with only this file's imports
 * changed** — the two builds are minutes apart, so nothing else moved between them. Read the pair,
 * not the absolutes: the same figures moved by ~5 kB later the same afternoon on other people's
 * merges, which is why `chem/rdkit.ts` no longer publishes one at all.
 *
 *  - What a browser fetches to run the app (the entry module plus every chunk `index.html` tells
 *    it to preload) went **653.72 kB → 596.79 kB** raw, **199.40 kB → 189.42 kB** gzip.
 *  - The four panels left as **60.52 kB** of route chunks — ReviewQueue 10.48, JobsPanel 6.40,
 *    ProtocolsPanel 4.44, ProtocolDocument 39.20 — fetched when they are wanted.
 *
 * The entry chunk alone reads 643.70 kB → 505.90 kB, and quoting *that* would overstate the win by
 * more than double: 80.9 kB of it is shared code Rolldown moved into new chunks (`chatStore`,
 * `Feedback`, `clsx`, `tslib`) that `index.html` still preloads. The set is the number; the entry
 * chunk is one member of it.
 *
 * The saving is also smaller than the 60.52 kB the panels weigh, and the reason is worth writing
 * down rather than rounding away: everything they *share* with the chat — the api client, the
 * stores, the shadcn primitives, the chem components — stays on the critical path because the
 * conversation route needs it too. Splitting moves what is exclusive to a route, not what a route
 * merely uses.
 */
const loadReviewQueue = () =>
  import('./components/ReviewQueue.tsx').then((m) => ({ default: m.ReviewQueue }));
const loadJobsPanel = () =>
  import('./components/JobsPanel.tsx').then((m) => ({ default: m.JobsPanel }));
const loadProtocolsPanel = () =>
  import('./components/ProtocolsPanel.tsx').then((m) => ({ default: m.ProtocolsPanel }));
const loadProtocolDocument = () =>
  import('./components/ProtocolDocument.tsx').then((m) => ({ default: m.ProtocolDocument }));

const ReviewQueue = lazy(loadReviewQueue);
const JobsPanel = lazy(loadJobsPanel);
const ProtocolsPanel = lazy(loadProtocolsPanel);
const ProtocolDocument = lazy(loadProtocolDocument);

let prefetched = false;

/**
 * Warm all four chunks. Safe to call repeatedly; only the first call fetches.
 *
 * Called from an idle callback once the app is up, which is the honest version of what a static
 * import was doing: the bytes still arrive on a normal session, they simply stop being on the
 * critical path to the first paint. A nav link cannot warm them on hover — the sidebar and the top
 * bar own those controls and this module has no business reaching into them — so idle is where the
 * warming goes, and it is what keeps the Suspense fallbacks below almost always unrendered.
 */
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
 * A lazily-loaded panel, with a fallback that says which one.
 *
 * Inside `AppShell` rather than around it, so the sidebar, the top bar and the banner stay exactly
 * where they are while a route chunk arrives — the reader sees the same page with one region
 * loading, which is what navigating between panels already looks like.
 */
function Panel({ what, children }: { what: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Suspense fallback={<Loading className="justify-center p-8">{what}</Loading>}>
      {children}
    </Suspense>
  );
}

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
  // After the first paint, never before it: `requestIdleCallback` runs when the browser has
  // nothing better to do, which is precisely the budget these four chunks are allowed to spend.
  // The `setTimeout` is for Safari, which still ships no idle callback; two seconds is well past
  // any first paint and nothing is waiting on it.
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
      <Route path="/s/:sessionId" element={<SessionResolver />} />
      {/* None of these is a conversation, so they render inside the shell with no conversation:
          the sidebar, the top bar and the banner stay where they are, and Back returns to the
          thread the reader came from. */}
      {/* `/jobs/:jobId` opens the jobs panel with one row already open. It was reachable only by
          clicking, so an operator could not be *sent* to a run — the same argument the protocol
          document's own comment below makes about a design id, and that id appears in an answer
          too. The panel reads the parameter itself rather than being handed a prop, so the URL
          stays the one thing that says what is open.

          `/review/:proposalId` stood beside it and is gone. Chemclaw3 deleted the PR-gate and its
          `/proposals` routes (`D-2026-09-05-the-gate-follows-behaviour-not-knowledge`), so there
          is no proposal to be sent to. `/review` itself stays: that page's other two sections —
          plans and questions — are live, and it is still where a chemist finds what is waiting on
          them. */}
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
      {/* The list and one document. The document reads its own `:designId` rather than being
          handed one, exactly as `ConversationRoute` does: the URL is what says which design is
          open, so a shared link and a reload land on the same one. A design id is minted by the
          service and appears in an answer, so it is genuinely worth being in a URL — unlike a
          session id, which `/s/:sessionId` exists to work around. */}
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
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
