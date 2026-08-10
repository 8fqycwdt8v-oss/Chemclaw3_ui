/**
 * The conversation surface — what this app was before the workbench had other routes.
 *
 * Composed of the same components in the same order as before, with one addition: the profile
 * picker, which only exists before a session does.
 *
 * `Composer` keeps its own `dryRun` as component-local state. That state resets when this route
 * unmounts, which is a real behaviour change from a single-page app that never unmounted it: a
 * chemist who ticks "dry run", walks over to /jobs and comes back finds it unticked. Left as it
 * is on purpose — lifting it into a store would be a second source of truth for a toggle the
 * composer owns, and "dry run defaults to off" is the safer of the two ways to be wrong.
 */

import { useChatStore } from '../state/chatStore.ts';
import { MessageList } from '../components/MessageList.tsx';
import { JobFeed } from '../components/JobFeed.tsx';
import { EntityRail } from '../components/EntityRail.tsx';
import { Composer } from '../components/Composer.tsx';
import { ProfilePicker } from './ProfilePicker.tsx';

export function ChatView(): React.JSX.Element {
  const activeId = useChatStore((s) => s.activeId);
  const conversation = useChatStore((s) => (activeId ? s.conversations[activeId] : undefined));

  if (!conversation) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-ink-muted">Starting a conversation…</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <MessageList conversation={conversation} />
        <JobFeed />
        <ProfilePicker
          conversationId={conversation.id}
          sessionId={conversation.sessionId ?? null}
        />
        <Composer conversationId={conversation.id} />
      </div>
      <EntityRail conversationId={conversation.id} />
    </div>
  );
}
