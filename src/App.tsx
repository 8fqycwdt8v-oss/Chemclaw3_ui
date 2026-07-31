import { useEffect } from 'react';
import { configProblems } from './env.ts';
import { useAuth } from './auth/AuthContext.tsx';
import { useChatStore } from './state/chatStore.ts';
import { api } from './api/client.ts';
import { useJobFeed } from './hooks/useJobFeed.ts';
import { Sidebar } from './components/Sidebar.tsx';
import { TopBar } from './components/TopBar.tsx';
import { MessageList } from './components/MessageList.tsx';
import { JobFeed } from './components/JobFeed.tsx';
import { Composer } from './components/Composer.tsx';
import type { ChatMessage } from './state/types.ts';

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
      const messages: ChatMessage[] = remote
        .filter((m) => m.text?.trim())
        .map((m, i) =>
          m.role === 'user'
            ? { id: `h${i}`, role: 'user' as const, text: m.text, at: Date.now() }
            : {
                id: `h${i}`,
                role: 'assistant' as const,
                at: Date.now(),
                status: 'done' as const,
                streamedText: '',
                finalText: m.text,
                confidence: null,
                unsupportedClaims: [],
                reviewRequired: false,
                trace: [],
                latestPlan: null,
                error: null,
              },
        );
      useChatStore.getState().hydrateTranscript(conversation.id, messages);
    })();
    return () => {
      cancelled = true;
    };
  }, [conversation?.id, conversation?.sessionId, conversation?.messages.length, auth]);

  useJobFeed(conversation?.sessionId ?? null, auth);

  const problems = configProblems();
  if (problems.length > 0) return <ConfigError problems={problems} />;

  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        {conversation ? (
          <>
            <MessageList conversation={conversation} />
            <JobFeed />
            <Composer conversationId={conversation.id} />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-ink-muted">Starting a conversation…</p>
          </div>
        )}
      </div>
    </div>
  );
}
