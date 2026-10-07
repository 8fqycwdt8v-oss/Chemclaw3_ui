/**
 * Who is in a conversation, and the controls each holds.
 *
 * Membership grants reach, not authority: a member reads and sends, and each message runs as the
 * sender. Plans are decided by the turn's author; delete and branch stay the owner's. The owner
 * sees everyone, admits by account id and removes anyone; a member sees the roster and can leave.
 * Rules are enforced upstream; this panel hides controls that could only 403 and shows the
 * service's own message when one comes back.
 */

import { useId, useState } from 'react';
import { useNavigate } from 'react-router';
import type { UseQueryResult } from '@tanstack/react-query';
import { UserMinus, UserPlus, Users } from 'lucide-react';
import { api, type SessionMembersOut, type SharedSessionSummary } from '../api/client.ts';
import { ApiError } from '../api/errors.ts';
import { keys, queryClient, useApiQuery } from '../api/queryClient.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import type { AuthProvider } from '../auth/types.ts';
import { useChatStore } from '../state/chatStore.ts';
import { announceStatus } from '../state/announce.ts';
import { relativeTime } from '../lib/format.ts';
import { logger } from '../lib/logger.ts';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { ConfirmDialog } from '@/components/chem/ConfirmDialog';
import { Loading } from '@/components/chem/Feedback';

/** How long a roster read is trusted. Short: another person can change it at any moment, and the
 *  panel is opened on purpose, so a re-read on open is the point rather than waste. */
const MEMBERS_STALE_MS = 5_000;

/**
 * Leave a conversation somebody else owns, server first (as `deleteConversation` in `Sidebar.tsx`)
 * so a failed request leaves something to retry. A 404 (already removed) counts as success. Returns
 * whether the conversation is gone.
 */
export async function leaveConversation(id: string, auth: AuthProvider): Promise<boolean> {
  const conversation = useChatStore.getState().conversations[id];
  const me = auth.account?.id;
  if (!conversation?.sessionId || !me) {
    useChatStore.getState().setBanner({
      kind: 'warn',
      text: 'Could not leave this conversation: you are not signed in.',
    });
    return false;
  }
  try {
    await api.removeMember(conversation.sessionId, me, auth);
  } catch (err) {
    if (!(err instanceof ApiError && err.kind === 'session_not_found')) {
      logger.warn('session.leave_failed', { kind: err instanceof ApiError ? err.kind : 'unknown' });
      useChatStore.getState().setBanner({
        kind: 'warn',
        text:
          err instanceof Error
            ? `You are still in this conversation: ${err.message}`
            : 'You are still in this conversation.',
        action: 'retry',
      });
      return false;
    }
  }
  // Drop the cached listing row first: the sidebar re-adopts whatever it names on remount, which
  // leaving triggers by navigating away.
  const left = conversation.sessionId;
  queryClient.setQueryData<SharedSessionSummary[]>(keys.sharedSessions, (rows) =>
    rows?.filter((row) => row.session_id !== left),
  );
  useChatStore.getState().deleteConversation(id);
  void queryClient.invalidateQueries({ queryKey: keys.sharedSessions });
  announceStatus('You left the conversation.');
  return true;
}

/**
 * The roster read, shared with the shell (`useSharedConversationSync` in `App.tsx`). Reconciles
 * `Conversation.membership` as a side effect, since this is the one read that can say "you own
 * this".
 */
export function useMembers(
  conversationId: string,
  sessionId: string | null,
  enabled: boolean,
  staleTime: number = MEMBERS_STALE_MS,
): UseQueryResult<SessionMembersOut, ApiError> {
  const { auth, ready } = useAuth();
  return useApiQuery<SessionMembersOut, ApiError>({
    queryKey: keys.members(sessionId ?? ''),
    queryFn: async () => {
      const roster = await api.listMembers(sessionId ?? '', auth);
      const me = auth.account?.id;
      if (me && roster.owner !== null) {
        useChatStore
          .getState()
          .setMembership(conversationId, roster.owner === me ? undefined : { owner: roster.owner });
      }
      return roster;
    },
    enabled: enabled && ready && Boolean(sessionId),
    staleTime,
  });
}

/** An actor id as a person reads it: "you" for the reader, the id itself for anybody else. */
function Who({ actor, me }: { actor: string | null; me: string | null }): React.JSX.Element {
  if (actor === null) return <span className="text-ink-muted">not recorded</span>;
  if (actor === me) return <span className="font-medium">You</span>;
  return <span className="font-mono text-xs break-all">{actor}</span>;
}

export function MembersPanel({
  conversationId,
  onLeft,
}: {
  conversationId: string;
  /** Called once this person has left, so a surrounding sheet can close over a conversation that
   *  no longer exists here. */
  onLeft?: () => void;
}): React.JSX.Element {
  const { auth } = useAuth();
  const navigate = useNavigate();
  const sessionId = useChatStore((s) => s.conversations[conversationId]?.sessionId ?? null);
  const me = auth.account?.id ?? null;
  const { data, error, isPending, refetch } = useMembers(conversationId, sessionId, true);

  const inputId = useId();
  const hintId = useId();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (!sessionId) {
    return (
      <p className="text-sm text-ink-muted">
        Nobody else can be added until this conversation has been started — send its first message.
      </p>
    );
  }
  if (isPending) return <Loading size="xs">Reading who is in this conversation…</Loading>;
  if (error || !data) {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-danger-ink">
          {error?.kind === 'session_not_found'
            ? 'Could not read who is in this conversation. You may have been removed from it, or this service does not support shared conversations.'
            : `Could not read who is in this conversation${error ? `: ${error.message}` : '.'}`}
        </p>
        <Button variant="outline" size="xs" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const owner = data.owner;
  const isOwner = owner !== null && owner === me;

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: keys.members(sessionId) });
  };

  const admit = async (): Promise<void> => {
    const actor = draft.trim();
    if (!actor) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.addMember(sessionId, actor, auth);
      setDraft('');
      announceStatus(`Added ${actor} to this conversation.`);
      refresh();
    } catch (err) {
      // Show the service's message for every refusal (403 not owner, 409 owner naming themself, 422
      // blank id).
      setProblem(err instanceof Error ? err.message : 'Could not add them.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (actor: string): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await api.removeMember(sessionId, actor, auth);
      announceStatus(`Removed ${actor} from this conversation.`);
    } catch (err) {
      // 404 is "not a member" — somebody else removed them first, or they left. The roster is
      // re-read either way, so the row goes and the reader is told why it went.
      setProblem(
        err instanceof ApiError && err.kind === 'session_not_found'
          ? `${actor} was no longer a member.`
          : err instanceof Error
            ? err.message
            : 'Could not remove them.',
      );
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <div className="space-y-4">
      <section aria-label="People in this conversation" className="space-y-2">
        <ul className="space-y-1.5">
          <li className="flex items-baseline justify-between gap-2 text-sm">
            <Who actor={owner} me={me} />
            <span className="shrink-0 text-2xs text-ink-subtle">owner</span>
          </li>
          {data.members.map((member) => (
            <li key={member.actor} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0">
                <Who actor={member.actor} me={me} />
                <span className="block text-2xs text-ink-subtle">
                  added {relativeTime(Date.parse(member.added_at))}
                </span>
              </span>
              {isOwner && (
                <ConfirmDialog
                  trigger={
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={busy}
                      aria-label={`Remove ${member.actor}`}
                    >
                      <UserMinus aria-hidden />
                      Remove
                    </Button>
                  }
                  title="Remove them from this conversation?"
                  description="They can no longer read it or send into it, from their very next request. What they already wrote stays in the transcript."
                  confirmLabel="Remove"
                  variant="destructive"
                  onConfirm={() => void remove(member.actor)}
                />
              )}
            </li>
          ))}
        </ul>
        {data.members.length === 0 && (
          <p className="text-xs text-ink-muted">Nobody else has been added.</p>
        )}
      </section>

      {isOwner ? (
        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void admit();
          }}
        >
          <label htmlFor={inputId} className="block text-xs font-medium">
            Add a person by their account id
          </label>
          <div className="flex gap-2">
            <input
              id={inputId}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-describedby={hintId}
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-surface px-3 py-1.5 font-mono text-xs outline-none focus-ring"
            />
            <Button type="submit" size="sm" disabled={busy || draft.trim() === ''}>
              <UserPlus aria-hidden />
              Add
            </Button>
          </div>
          <p id={hintId} className="text-2xs leading-snug text-ink-muted">
            Their Entra object id. They will read everything here and can send into it. Each message
            runs as its sender — their roles, their memories — and a plan their message produces is
            theirs alone to approve.
          </p>
        </form>
      ) : (
        <div className="space-y-2">
          <p className="text-xs leading-snug text-ink-muted">
            {owner === null
              ? 'This conversation has no recorded owner.'
              : 'You were added to this conversation by its owner.'}{' '}
            Your messages here run as you. Only the owner can add people, branch it or delete it.
          </p>
          {me && data.members.some((m) => m.actor === me) && (
            <ConfirmDialog
              trigger={
                <Button variant="outline-destructive" size="sm" disabled={busy}>
                  Leave this conversation
                </Button>
              }
              title="Leave this conversation?"
              description="You will no longer be able to read it or send into it. Only its owner can add you back."
              confirmLabel="Leave"
              variant="destructive"
              onConfirm={() => {
                setBusy(true);
                void leaveConversation(conversationId, auth).then((left) => {
                  setBusy(false);
                  if (!left) return;
                  onLeft?.();
                  void navigate('/');
                });
              }}
            />
          )}
        </div>
      )}

      {problem && (
        <p role="alert" className="text-xs text-danger-ink">
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * The header control that opens the panel. The roster is read when the sheet opens, not per header
 * render, since most conversations have one member.
 */
export function MembersTrigger({
  conversationId,
}: {
  conversationId: string;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const hasSession = useChatStore((s) => Boolean(s.conversations[conversationId]?.sessionId));
  const shared = useChatStore((s) => Boolean(s.conversations[conversationId]?.membership));
  if (!hasSession) return null;
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={shared ? 'People in this shared conversation' : 'People in this conversation'}
        >
          <Users />
        </Button>
      </SheetTrigger>
      <SheetContent side="right" title="People in this conversation" className="w-80 p-0">
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 pt-10">
          <h2 className="mb-3 text-sm font-semibold">People in this conversation</h2>
          {open && <MembersPanel conversationId={conversationId} onLeft={() => setOpen(false)} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}
