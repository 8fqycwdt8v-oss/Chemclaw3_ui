/**
 * One conversation's artefacts, as every eager surface reads them (shell layout, top-bar toggle,
 * cards rebuilt from a reloaded transcript), under one key (`keys.exhibits`).
 *
 * Keyed on the session, which scopes artefacts upstream. No session means nothing is fetched.
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
  /**
   * Whether there is a pane to show: artefacts on, or off with some already written. Off stops
   * making artefacts, not showing existing ones ("My artefacts" opens the pane on them).
   */
  visible: boolean;
  /** Off with artefacts in hand: the pane shows them, with no way to make, edit or hand one on. */
  readOnly: boolean;
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
  const enabled = data?.enabled === true;
  const exhibits = data?.exhibits ?? NONE;
  return {
    sessionId,
    enabled,
    visible: enabled || exhibits.length > 0,
    readOnly: !enabled,
    exhibits,
  };
}

/** Tailwind's `lg`, which is where the right column exists at all (`EntityRail`'s own breakpoint). */
const WIDE = '(min-width: 64rem)';

const wideNow = (): boolean =>
  typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? true
    : window.matchMedia(WIDE).matches;

/**
 * Whether the screen holds the right column (`lg`), followed live. The pane is a column when wide
 * and a sheet below, two behaviours, so a component must read it. No `matchMedia` reads as wide.
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
