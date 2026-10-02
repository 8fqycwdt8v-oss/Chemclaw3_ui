/**
 * One conversation's artefacts, as every eager surface reads them.
 *
 * Eager rather than inside the lazy pane chunk, because three things outside the pane need the
 * list before anybody opens it: the shell decides whether the right column is the rail or the
 * pane, the top bar decides whether to offer the toggle, and an answer's card reads its title off
 * the list when it was rebuilt from a reloaded transcript. One key (`keys.exhibits`) is what makes
 * those three one request.
 *
 * Keyed on the conversation's *session*, which is what the service scopes artefacts to. A
 * conversation with no session yet has none, and nothing is asked — `warmSession` gives a fresh
 * conversation a session before its first message, and a list read for it would be a request that
 * can only answer "empty".
 */

import { useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthContext.tsx';
import { useApiQuery } from '../../api/queryClient.ts';
import { exhibitsQuery } from '../../api/queries.ts';
import { useChatStore } from '../../state/chatStore.ts';
import type { ExhibitHeader } from '../../../shared/exhibits.ts';

const NONE: ExhibitHeader[] = [];

export interface SessionExhibits {
  sessionId: string | null;
  /** The deployment's switch. `false` until the list has answered, so nothing flashes on. */
  enabled: boolean;
  exhibits: ExhibitHeader[];
}

export function useSessionExhibits(conversationId: string | undefined): SessionExhibits {
  const { auth, ready } = useAuth();
  const sessionId = useChatStore((s) =>
    conversationId ? (s.conversations[conversationId]?.sessionId ?? null) : null,
  );
  const { data } = useApiQuery({
    ...exhibitsQuery(sessionId ?? '', auth),
    enabled: ready && Boolean(sessionId),
  });
  return {
    sessionId,
    enabled: data?.enabled === true,
    exhibits: data?.exhibits ?? NONE,
  };
}

/** Tailwind's `lg`, which is where the right column exists at all (`EntityRail`'s own breakpoint). */
const WIDE = '(min-width: 64rem)';

const wideNow = (): boolean =>
  typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? true
    : window.matchMedia(WIDE).matches;

/**
 * Whether the screen holds the right column, followed live.
 *
 * The pane is a column at `lg` and a sheet below it, and — unlike the rail, which hides one copy
 * with CSS — those are two *different behaviours* (`useExhibitPane.sheetOpen`), so the decision
 * has to be one a component can read. An environment with no `matchMedia` (a test, an old WebView)
 * reads as wide, which is the layout every unit test of the pane was written against.
 */
export function useWideScreen(): boolean {
  const [wide, setWide] = useState(wideNow);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(WIDE);
    const onChange = (): void => setWide(query.matches);
    onChange();
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);
  return wide;
}
