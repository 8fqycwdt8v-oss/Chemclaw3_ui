import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { configProblems } from './env.ts';
import { useAuth } from './auth/AuthContext.tsx';
import { useChatStore } from './state/chatStore.ts';
import { api } from './api/client.ts';
import { useJobFeed } from './hooks/useJobFeed.ts';
import { Sidebar } from './components/Sidebar.tsx';
import { TopBar } from './components/TopBar.tsx';
import { ChatView } from './views/ChatView.tsx';
import { JobsView } from './views/JobsView.tsx';
import { ReviewView } from './views/ReviewView.tsx';
import { ApprovalsView } from './views/ApprovalsView.tsx';
import { messagesFromTranscript } from './state/transcript.ts';

function ConfigError({ problems }: { problems: string[] }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-lg rounded-lg border border-danger/40 bg-danger-soft p-5">
        <h1 className="mb-2 font-semibold text-danger">Configuration error</h1>
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

export function App(): React.JSX.Element {
  const { auth } = useAuth();
  const activeId = useChatStore((s) => s.activeId);
  const conversation = useChatStore((s) => (activeId ? s.conversations[activeId] : undefined));
  const { pathname } = useLocation();

  // Always have a conversation to type into.
  useEffect(() => {
    const state = useChatStore.getState();
    if (!state.activeId || !state.conversations[state.activeId]) {
      const [first] = state.order;
      if (first && state.conversations[first]) state.selectConversation(first);
      else state.createConversation();
    }
  }, [activeId]);

  // Restore the transcript for a conversation whose session survived but whose messages were not
  // in localStorage — a different browser, or a cleared cache.
  useEffect(() => {
    if (!conversation?.sessionId || conversation.messages.length > 0) return;
    let cancelled = false;
    void (async () => {
      const remote = await api.getMessages(conversation.sessionId as string, () =>
        auth.getAccessToken(),
      );
      if (cancelled || remote.length === 0) return;
      useChatStore.getState().hydrateTranscript(conversation.id, messagesFromTranscript(remote));
    })();
    return () => {
      cancelled = true;
    };
  }, [conversation?.id, conversation?.sessionId, conversation?.messages.length, auth]);

  /**
   * Mounted here, above the router, and it must stay here.
   *
   * The backend caps concurrent event streams per user and answers 429 past the cap. This hook
   * opens exactly one stream per session and closes it when the session changes; moving it into
   * `ChatView` would still be one stream, but putting a second copy anywhere — a jobs view that
   * "also wants job pushes", say — would be two, and the second would spend the cap the first
   * needs. Above the router it also survives navigation, so a DFT job that lands while the
   * reviewer is reading the queue is still claimed and still reaches the chemist.
   */
  useJobFeed(conversation?.sessionId ?? null, auth);

  const problems = configProblems();
  if (problems.length > 0) return <ConfigError problems={problems} />;

  /**
   * The sidebar is the conversation list, and it does not travel.
   *
   * Every control in it acts on the chat surface — select a conversation, start a new one, reset
   * the app — and none of them navigate. On `/review` a click would silently change what `/` shows
   * while leaving the reader where they are, so its visible effect would be nothing. The
   * alternative, teaching it to navigate, would put a 16rem conversation list beside a document
   * somebody is signing off on. So the workbench routes are full width and the top bar is the way
   * back.
   *
   * Unmounting it re-runs its `GET /sessions` pull on the way back to chat. That call is idempotent
   * and its additions are deduplicated against the local list, and picking up a conversation
   * started elsewhere is the thing it exists to do — so a refetch per return is a feature, not the
   * cost it looks like.
   */
  const onChat = pathname === '/';

  return (
    <div className="flex h-full">
      {onChat && <Sidebar />}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <Routes>
          <Route path="/" element={<ChatView />} />
          <Route path="/jobs" element={<JobsView />} />
          <Route path="/review" element={<ReviewView />} />
          <Route path="/approvals" element={<ApprovalsView />} />
          {/* A deep link the SPA does not know. `sirv(..., { single: true })` has already served
              index.html for it, so the only thing left to decide is where it lands. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}
