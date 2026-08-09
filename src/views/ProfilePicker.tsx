/**
 * Start a conversation as a narrowed agent.
 *
 * `POST /sessions` takes a `profile` and 400s an unknown one, and until `GET /profiles` was
 * reachable a surface had to hardcode names from files it cannot see. `property-lookup` is the
 * one that matters for a bench chemist: five tools, terse answers, no research loop — the dozens
 * of "what is this compound's pKa" questions a day that do not need the whole agent.
 *
 * **The profile is fixed when the session is created**, which is why this appears only while a
 * conversation has no session yet, and why choosing a non-default one creates the session right
 * then. The turn orchestrator's `ensureSession` mints a session on the first message with no
 * profile at all; there is no way to tell it about a choice made here except to have already made
 * the session. A default-agent pick therefore creates nothing and leaves that path exactly as it
 * was.
 *
 * Once a session exists this collapses to a label, and only when *this browser* made the choice.
 * The backend does not report a session's profile, so after a reload the honest answer is silence
 * rather than a guess at "general".
 */

import { useState } from 'react';
import { api } from '../api/client.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { useChatStore } from '../state/chatStore.ts';
import { useViewStore } from '../state/view.ts';
import { errorText, useResource } from './useResource.ts';

export function ProfilePicker({
  conversationId,
  sessionId,
}: {
  conversationId: string;
  sessionId: string | null;
}): React.JSX.Element | null {
  const { auth } = useAuth();
  // Not fetched once the session exists: the choice is already made and unchangeable, so the list
  // would be a request whose answer nothing can act on. The hook still runs (its position must be
  // stable) — it is the call that is skipped.
  const profiles = useResource<string[]>(
    (getToken) => (sessionId ? Promise.resolve([]) : api.listProfiles(getToken)),
    [sessionId],
  );
  const chosen = useViewStore((s) => s.profileByConversation[conversationId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (sessionId) {
    if (!chosen) return null;
    return (
      <p className="border-t border-border-subtle bg-surface-sunken px-4 py-1.5 text-xs text-ink-muted">
        This conversation runs as <span className="font-medium text-ink">{chosen}</span>. A
        profile is fixed at session creation — start a new conversation to use a different one.
      </p>
    );
  }

  const available = profiles.data ?? [];
  if (available.length === 0) return null;

  const start = async (profile: string): Promise<void> => {
    if (!profile) return;
    setBusy(true);
    setError(null);
    try {
      const { session_id } = await api.createSession(() => auth.getAccessToken(), profile);
      useChatStore.getState().setSessionId(conversationId, session_id);
      useViewStore.getState().rememberProfile(conversationId, profile);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle bg-surface-sunken px-4 py-1.5 text-xs">
      <span className="text-ink-muted">Start as</span>
      <span className="rounded border border-border-subtle bg-surface-raised px-1.5 py-0.5">
        general agent
      </span>
      {available.map((profile) => (
        <button
          key={profile}
          type="button"
          disabled={busy}
          onClick={() => void start(profile)}
          className="rounded border border-accent/40 bg-accent-soft px-1.5 py-0.5 text-accent hover:brightness-95 disabled:opacity-50"
        >
          {profile}
        </button>
      ))}
      <span className="text-ink-muted">— fixed once the first message is sent</span>
      {error !== null && <span className="text-danger">{error}</span>}
    </div>
  );
}
