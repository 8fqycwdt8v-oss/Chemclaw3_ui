import { useCallback, useEffect, useState } from 'react';
import { configProblems } from './env.ts';
import { useAuth } from './auth/AuthContext.tsx';
import { useChatStore } from './state/chatStore.ts';
import { api } from './api/client.ts';
import { useJobFeed } from './hooks/useJobFeed.ts';
import { useVisualViewport } from './hooks/useVisualViewport.ts';
import { Sidebar } from './components/Sidebar.tsx';
import { TopBar } from './components/TopBar.tsx';
import { MessageList } from './components/MessageList.tsx';
import { JobFeed } from './components/JobFeed.tsx';
import { Composer } from './components/Composer.tsx';
import { Announcer } from '@/components/chem/Announcer';
import { SkipLinks } from '@/components/chem/SkipLinks';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Loading } from '@/components/chem/Feedback';
import type { ChatMessage } from './state/types.ts';

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

export function App(): React.JSX.Element {
  const { auth } = useAuth();
  // Narrow selectors, deliberately. `updateAssistant` replaces the conversation object on every
  // animation frame, so selecting the object here re-rendered App — and with it the header, the
  // job feed and the composer — at the token rate. These three change only when they mean
  // something, and zustand v5 has no implicit shallow compare to fall back on.
  const activeId = useChatStore((s) => s.activeId);
  const exists = useChatStore((s) => Boolean(s.activeId && s.conversations[s.activeId]));
  const sessionId = useChatStore((s) =>
    s.activeId ? (s.conversations[s.activeId]?.sessionId ?? null) : null,
  );
  const messageCount = useChatStore((s) =>
    s.activeId ? (s.conversations[s.activeId]?.messages.length ?? 0) : 0,
  );
  const [rehydrateNonce, setRehydrateNonce] = useState(0);

  useVisualViewport();

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
    if (!activeId || !sessionId || messageCount > 0) return;
    let cancelled = false;
    void (async () => {
      // `getMessages` swallows only `session_not_found`; a 401, a 500 or a dropped connection all
      // rethrow. Unhandled, that surfaced as an empty conversation with no explanation and no way
      // to retry — the reader could not tell "nothing was said yet" from "we could not load it".
      let remote: Awaited<ReturnType<typeof api.getMessages>>;
      try {
        remote = await api.getMessages(sessionId, () => auth.getAccessToken());
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
                // Empty on a rehydrated transcript, and honestly so: the backend persists the
                // messages, not which connectors happened to be down when each was produced.
                degradedConnectors: [],
                // Same reason: a rehydrated message is finished, so it is not waiting on anything.
                queued: false,
                trace: [],
                latestPlan: null,
                error: null,
              },
        );
      useChatStore.getState().hydrateTranscript(activeId, messages);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId, sessionId, messageCount, auth, rehydrateNonce]);

  useJobFeed(sessionId, auth);

  // What the banner's Retry does. The retryable failures reachable from here are the transcript
  // read and, once the store carries one, the last turn — both are re-driven by clearing the
  // banner and letting the effect above run again.
  const onRetry = useCallback(() => {
    useChatStore.getState().setBanner(null);
    setRehydrateNonce((n) => n + 1);
  }, []);

  const problems = configProblems();
  if (problems.length > 0) return <ConfigError problems={problems} />;

  return (
    <TooltipProvider>
      <SkipLinks />
      <Announcer />

      <div className="flex h-full">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar onRetry={onRetry} />
          <main className="flex min-h-0 flex-1 flex-col">
            {activeId && exists ? (
              <>
                <MessageList conversationId={activeId} />
                <JobFeed />
                <Composer conversationId={activeId} />
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center">
                <Loading>Starting a conversation…</Loading>
              </div>
            )}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
