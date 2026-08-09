/**
 * Choose which specialised agent a new conversation talks to.
 *
 * `GET /profiles` exists because, in the backend's own words, a surface previously "had to
 * hardcode names that live in files it cannot see, and a deployment adding a profile had no way to
 * make it discoverable". This UI was that surface — it never sent a profile at all, so every
 * conversation used the default.
 *
 * Only offered before the first turn. The backend fixes a session's profile for its lifetime, so a
 * picker that stayed live afterwards would be offering something it cannot deliver.
 */

import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { useChatStore } from '../state/chatStore.ts';

export function ProfilePicker({
  conversationId,
}: {
  conversationId: string;
}): React.JSX.Element | null {
  const { auth } = useAuth();
  const [profiles, setProfiles] = useState<string[]>([]);
  const sessionId = useChatStore((s) => s.conversations[conversationId]?.sessionId ?? null);
  const selected = useChatStore((s) => s.conversations[conversationId]?.profile ?? null);
  const setProfile = useChatStore((s) => s.setProfile);

  useEffect(() => {
    let live = true;
    void (async () => {
      const names = await api.listProfiles(() => auth.getAccessToken());
      if (live) setProfiles(names);
    })();
    return () => {
      live = false;
    };
  }, [auth]);

  // Nothing to choose between, or the choice has already been made and fixed server-side.
  if (sessionId !== null || profiles.length === 0) return null;

  return (
    <div className="flex items-center gap-2 px-4 py-2">
      <label htmlFor="profile-picker" className="text-xs text-ink-muted">
        Agent
      </label>
      <select
        id="profile-picker"
        value={selected ?? ''}
        onChange={(e) => setProfile(conversationId, e.target.value || null)}
        className="rounded border border-border-subtle bg-surface-raised px-2 py-1 text-xs focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      >
        <option value="">Default</option>
        {profiles.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <span className="text-xs text-ink-muted">Fixed once the conversation starts.</span>
    </div>
  );
}
