/**
 * The application shell.
 *
 * Rendered by a route rather than mounted directly, so it takes the conversation to show rather
 * than reading `activeId` for itself. `children` is the escape hatch the not-found panel uses to
 * appear inside the normal chrome instead of replacing it.
 */

import { useCallback, useEffect, useState } from 'react';
import { configProblems } from './env.ts';
import { useAuth } from './auth/AuthContext.tsx';
import { useChatStore } from './state/chatStore.ts';
import { api } from './api/client.ts';
import { useJobStreams } from './hooks/useJobStreams.ts';
import { useJobNotifications } from './hooks/useJobNotifications.ts';
import { useVisualViewport } from './hooks/useVisualViewport.ts';
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
      useChatStore.getState().hydrateTranscript(conversationId, messages);
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, sessionId, messageCount, fromServer, auth, ready, nonce]);
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

  useVisualViewport();
  useRemoteTranscript(conversationId, rehydrateNonce);
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
