import { useEffect } from 'react';
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
      // Namespaced by conversation and stamped with the message's own time. Ids were `h0..hN`,
      // which collide across conversations, and `at` was `Date.now()` — so every restored message
      // claimed to have been sent at page load.
      const restoredAt = (m: { created_at?: string }, fallback: number): number => {
        const parsed = m.created_at ? Date.parse(m.created_at) : NaN;
        return Number.isFinite(parsed) ? parsed : fallback;
      };
      const base = Date.now();
      const messages: ChatMessage[] = remote
        .filter((m) => m.text?.trim())
        .map((m, i) =>
          m.role === 'user'
            ? {
                id: `${conversation.id}:h${i}`,
                role: 'user' as const,
                text: m.text,
                at: restoredAt(m, base),
              }
            : {
                id: `${conversation.id}:h${i}`,
                role: 'assistant' as const,
                at: restoredAt(m, base),
                status: 'done' as const,
                streamedText: '',
                finalText: m.text,
                confidence: null,
                unsupportedClaims: [],
                reviewRequired: false,
                // The backend does not persist which check scored a stored answer, so a restored
                // message states that it does not know rather than implying it was verified.
                verifiedBy: null,
                notice: null,
                // Empty on a rehydrated transcript, and honestly so: the backend persists the
                // messages, not which connectors happened to be down when each was produced.
                degradedConnectors: [],
                // Same reason: a rehydrated message is finished, so it is not waiting on anything.
                queued: false,
                // Rebuilt from the stored tool calls, so a reloaded conversation shows the work
                // that produced each answer instead of a bare paragraph. `result: null` on the
                // wire means the call raised or its return was not recorded — rendered as failed
                // rather than as still-running, which is what an absent result would otherwise
                // read as in `TracePanel`.
                trace: (m.tool_calls ?? []).map((call, j) => ({
                  id: `${conversation.id}:h${i}:t${j}`,
                  at: restoredAt(m, base),
                  kind: 'tool_call' as const,
                  toolCall: {
                    tool: call.tool,
                    arguments: call.arguments ?? '',
                    ...(call.result == null ? { failed: true as const } : { result: call.result }),
                  },
                })),
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
