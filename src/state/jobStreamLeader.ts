/**
 * One tab holds the job-completion streams; the others read what it saw.
 *
 * The backend caps live event streams per user per process and cannot see tabs, so two windows each
 * holding their own streams exceed the cap. Rule: someone must always hold the streams — a lost
 * notification is worse than watching fewer conversations.
 *
 * **Election.** Every tab requests the same exclusive Web Lock (`LOCK`); the holder leads. The
 * browser releases it when a tab closes, crashes or is killed, so takeover is immediate. A frozen
 * or bfcached tab still holds it, so `pagehide`/`freeze` release and `pageshow`/`resume`
 * re-request. A wedged-but-alive leader keeps the lock (accepted). Without `BroadcastChannel` or
 * `navigator.locks` every tab leads, which is safe (429s are handled).
 *
 * **What is watched.** Each tab `declare`s its own priority list; the leader watches the
 * round-robin merge (`mergeWatchSets`), capped at the account budget and rotated when starved. A
 * follower's periodic message is its interest, expiring after `INTEREST_LEASE_MS`.
 *
 * **What is relayed.** The leader `publish`es notes and stream health; store handlers are
 * idempotent. A row nobody has claimed survives a takeover, but the service's claim is destructive,
 * so a frame read by a tab that dies before relaying it is lost; `src/state/jobReconcile.ts`
 * recovers the fact from the run registry on takeover (`ISSUES.md` Issue 12).
 */

import type { AwaitingAnswerEvent, JobTerminalEvent } from '../../shared/events.ts';

/** The channel name, one per origin. Exported so tests can script a peer tab. */
export const CHANNEL = 'chemclaw.job-streams';

/**
 * The Web Lock whose holder leads. Separate from `CHANNEL` (different namespaces). Exported for
 * tests.
 */
export const LOCK = 'chemclaw.job-streams.leader';

/** How often a follower re-states what it wants watched; the message is also its keepalive. */
const ANNOUNCE_MS = 1_000;

/**
 * How long a tab's interest lasts without being restated. Long, because Chrome throttles hidden
 * tabs to one timer a minute and a backgrounded window is exactly the one whose notifications
 * matter. A tab leaving politely announces an empty interest; a dead tab's stale slot only wastes
 * one stream until it expires (rotation prevents starvation). Exported for tests.
 */
export const INTEREST_LEASE_MS = 5 * 60 * 1_000;

/** What a leader tells the other tabs. Everything here is structured-clone safe. */
export type Note =
  | { kind: 'job'; event: JobTerminalEvent; sessionId: string }
  | { kind: 'awaiting'; event: AwaitingAnswerEvent }
  /** An artefact moved in a watched session; the receiver refetches that session's list. */
  | { kind: 'exhibit'; sessionId: string }
  | { kind: 'health'; failing: readonly string[]; throttled: boolean };

/**
 * What tabs say to each other. `hello` asks for the picture a tab missed: on arrival (the leader
 * answers with stream health) and on becoming leader (followers answer with their interests).
 */
type Message =
  | { type: 'hello'; from: string }
  | { type: 'interest'; from: string; sessions: readonly string[] }
  | { type: 'note'; from: string; note: Note };

/**
 * How long one arrangement stands before the merge rotates, only when interested tabs outnumber the
 * budget. Each step costs a connect; a dark window only waits, since unclaimed rows persist.
 * Exported for tests.
 */
export const ROTATION_MS = 60_000;

/**
 * The account's watch set from each tab's priority list. Round-robin by rank, so every window's
 * first choice is watched before anyone's second. When tabs' first choices outnumber the budget,
 * the order rotates by `turn` so each is watched for a share of the time; otherwise `turn` changes
 * nothing. `mine` goes first at each rank for determinism; empty lists are dropped. Exported for
 * tests.
 */
export function mergeWatchSets(
  mine: readonly string[],
  peers: readonly (readonly string[])[],
  budget: number,
  turn = 0,
): string[] {
  const lists = [mine, ...peers].filter((list) => list.length > 0);
  const start =
    lists.length > budget ? ((Math.trunc(turn) % lists.length) + lists.length) % lists.length : 0;
  const order = start === 0 ? lists : [...lists.slice(start), ...lists.slice(0, start)];
  const merged: string[] = [];
  const depth = Math.max(0, ...order.map((list) => list.length));
  for (let rank = 0; rank < depth && merged.length < budget; rank += 1) {
    for (const list of order) {
      const sessionId = list[rank];
      if (sessionId === undefined || merged.includes(sessionId)) continue;
      merged.push(sessionId);
      if (merged.length >= budget) break;
    }
  }
  return merged;
}

/** One tab's membership of the election. */
export interface StreamLeader {
  /** This tab's identity in the election. Exposed because every failure mode above is about which
   *  tab is which, and a test that cannot name them cannot assert on them. */
  readonly id: string;
  /** Does this tab hold the streams? */
  isLeader(): boolean;
  /**
   * What this tab wants watched, in priority order, and the account budget. Told to every tab, so a
   * takeover already knows.
   */
  declare(sessions: readonly string[], budget: number): void;
  /** What this tab must open: empty for a follower; the capped merge for the leader. */
  watched(): readonly string[];
  /** Called whenever either answer changes, so a React hook can re-render. Returns an
   *  unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Apply a note here and send it to the other tabs. Only the leader has anything to publish. */
  publish(note: Note): void;
  /**
   * Leave. `announce: false` simulates a crash for tests (nothing sent, lock still released by the
   * "browser"); production calls `close()`.
   */
  close(options?: { announce?: boolean }): void;
}

/**
 * A short random id for this tab: keys its interest, filters its own broadcasts, breaks merge ties.
 */
function mintId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Is this something one of our tabs sent? Another version of this app in another tab is the
 *  realistic sender of anything else, so the shape is checked rather than assumed. */
function isMessage(data: unknown): data is Message {
  if (typeof data !== 'object' || data === null) return false;
  const { type, from } = data as { type?: unknown; from?: unknown };
  if (typeof from !== 'string') return false;
  if (type === 'interest') {
    // `sessions` decides which streams open, so it is validated; notes are passed as-is (sender is
    // this app, handlers normalise).
    const { sessions } = data as { sessions?: unknown };
    return Array.isArray(sessions) && sessions.every((s) => typeof s === 'string');
  }
  return type === 'hello' || type === 'note';
}

/**
 * Join the election. `deliver` applies a note to the store; it runs for the leader's own notes too,
 * so leader and followers share one path.
 */
export function createStreamLeader(deliver: (note: Note) => void): StreamLeader {
  const id = mintId();
  const listeners = new Set<() => void>();
  let leader = false;
  let closed = false;
  /** The most recent health note, replayed to a tab that joins later. */
  let health: Note | null = null;
  /** What this tab asked for, and the account budget it believes applies. */
  let mine: readonly string[] = [];
  let budget = 0;
  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const channel = openChannel();
  const locks = lockManager();
  // No channel or no lock manager: every tab leads and watches only its own (never "watch
  // nothing"). One branch for both, since a half-coordinated mode would either need a hand-run
  // election or open the same streams in every tab.
  if (!channel || !locks) {
    return {
      id,
      isLeader: () => true,
      declare: (sessions, nextBudget) => {
        mine = sessions;
        budget = nextBudget;
        notify();
      },
      // Through `mergeWatchSets` so a lone tab and one without a channel cannot drift apart.
      watched: () => mergeWatchSets(mine, [], budget),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      publish: (note) => deliver(note),
      close: () => undefined,
    };
  }

  /**
   * Releases the lock (resolving the promise the lock callback returned is the only way), or `null`
   * when not held.
   */
  let release: (() => void) | null = null;
  /** Is a `locks.request` queued or running? Stops `pageshow` queueing a second one behind the
   *  first, which would leave this tab holding the lock twice and releasing it once. */
  let requested = false;
  /**
   * Other tabs' interests and when they last said so; expired after `INTEREST_LEASE_MS`. A closing
   * follower sends an empty interest, freeing its slot at once.
   */
  const asked = new Map<string, { sessions: readonly string[]; at: number }>();
  let watched: readonly string[] = [];

  const now = (): number => Date.now();

  /** Recompute the watch set, dropping tabs that have gone quiet. Returns whether it moved. */
  const rebuild = (): boolean => {
    let next: readonly string[] = [];
    if (leader) {
      const cutoff = now() - INTEREST_LEASE_MS;
      for (const [peer, interest] of asked) if (interest.at <= cutoff) asked.delete(peer);
      const peers = [...asked.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([, interest]) => interest.sessions);
      // Rotation step from the clock, so it advances once per `ROTATION_MS` however often `rebuild`
      // runs.
      next = mergeWatchSets(mine, peers, budget, Math.floor(now() / ROTATION_MS));
    }
    if (next.length === watched.length && next.every((s, i) => s === watched[i])) return false;
    watched = next;
    return true;
  };

  const setLeader = (nextLeader: boolean): void => {
    if (leader === nextLeader) return;
    leader = nextLeader;
    rebuild();
    notify();
  };

  const announce = (): void => send({ type: 'interest', from: id, sessions: mine });

  const send = (message: Message): void => {
    try {
      channel.postMessage(message);
    } catch {
      // A channel closed under us, or a note that will not clone. Neither is worth taking the tab
      // down for, and the lease makes a leader that has gone mute recoverable anyway.
    }
  };

  /**
   * Queue for the lock and hold it until this tab resolves the returned promise. Followers are tabs
   * whose callback has not run yet.
   */
  const takeTheStreams = (): void => {
    if (closed || requested) return;
    requested = true;
    void locks
      .request(LOCK, { mode: 'exclusive' }, () => {
        return new Promise<void>((resolve) => {
          if (closed) {
            resolve();
            return;
          }
          release = resolve;
          setLeader(true);
          // A new leader has never heard the others' interests: ask now, not on the next tick.
          send({ type: 'hello', from: id });
        });
      })
      .catch(() => {
        // The lock request failed: lead anyway (someone holding the streams beats nobody).
        if (!closed) setLeader(true);
      })
      .finally(() => {
        requested = false;
      });
  };

  /** Give the streams back. The next tab in the browser's queue is leading before this returns. */
  const standDown = (): void => {
    const resolve = release;
    release = null;
    setLeader(false);
    resolve?.();
  };

  channel.addEventListener('message', (event) => {
    const message = (event as MessageEvent).data;
    if (closed || !isMessage(message) || message.from === id) return;

    switch (message.type) {
      case 'hello':
        // Each role answers with the half it owns: the leader with stream health, followers with
        // interests.
        if (leader) {
          if (health) send({ type: 'note', from: id, note: health });
        } else {
          announce();
        }
        break;
      case 'interest':
        // An empty interest replaces the tab's previous one, which frees its slot (`mergeWatchSets`
        // drops empty lists).
        asked.set(message.from, { sessions: message.sessions, at: now() });
        if (leader && rebuild()) notify();
        break;
      case 'note':
        deliver(message.note);
        break;
    }
  });

  // The module's one timer: the interest protocol.
  const watchdog = setInterval(() => {
    if (closed) return;
    if (leader) {
      // The leader's own tick does the expiring, and the rotation: a tab that has stopped
      // announcing stops being counted, and the slot it held goes to somebody who is still here.
      if (rebuild()) notify();
      return;
    }
    // A follower's periodic message *is* its interest, which is why there is no separate keepalive:
    // one message per second per role, and the thing it carries is the thing the leader needs.
    announce();
  }, ANNOUNCE_MS);

  // `pagehide` rather than `beforeunload` (fires on mobile app switch and bfcache entry). A leader
  // must release here: a frozen tab keeps the lock while reading nothing.
  const onHide = (): void => {
    if (leader) standDown();
    // A follower has nothing to release and, since `INTEREST_LEASE_MS` is five minutes, everything
    // to say: without this its slot is held for a window that is gone.
    else send({ type: 'interest', from: id, sessions: [] });
  };
  // A tab restored from the cache re-joins the lock queue.
  const onShow = (): void => {
    if (!closed && !leader) takeTheStreams();
  };
  if (typeof addEventListener === 'function') {
    // Two pairs: `pagehide`/`pageshow` (unload, bfcache) and `freeze`/`resume` (frozen in place, no
    // `pagehide`).
    for (const event of ['pagehide', 'freeze']) addEventListener(event, onHide);
    for (const event of ['pageshow', 'resume']) addEventListener(event, onShow);
  }

  takeTheStreams();
  // Ask for what this tab missed; the leader answers with stream health.
  send({ type: 'hello', from: id });

  return {
    id,
    isLeader: () => leader,
    declare: (sessions, nextBudget) => {
      if (closed) return;
      const moved = nextBudget !== budget || sessions.join(',') !== mine.join(',');
      mine = sessions;
      budget = nextBudget;
      if (!moved) return;
      // A leader consumes its own interest; a follower has to send it, and at once rather than on
      // the next tick — the conversation a chemist just opened is the one they are watching now.
      if (leader) {
        if (rebuild()) notify();
      } else {
        announce();
      }
    },
    watched: () => watched,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish: (note) => {
      if (note.kind === 'health') health = note;
      deliver(note);
      send({ type: 'note', from: id, note });
    },
    close: (options) => {
      if (closed) return;
      closed = true;
      if (options?.announce !== false) {
        // A follower frees its slot; a leader's release is the announcement.
        if (!leader) send({ type: 'interest', from: id, sessions: [] });
      }
      clearInterval(watchdog);
      if (typeof removeEventListener === 'function') {
        for (const event of ['pagehide', 'freeze']) removeEventListener(event, onHide);
        for (const event of ['pageshow', 'resume']) removeEventListener(event, onShow);
      }
      // A simulated crash leaves the channel open and silent.
      if (options?.announce !== false) channel.close();
      // The lock is released either way, as the browser does for a crashed tab.
      standDown();
    },
  };
}

/** `new BroadcastChannel`, or `null` where there is none. Constructing one can throw in a sandboxed
 *  or partitioned context, which is a reason to lead alone rather than a reason to fail. */
function openChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(CHANNEL);
  } catch {
    return null;
  }
}

/** `navigator.locks`, or `null`. Checked by value, not `in`: happy-dom defines it as `null`. */
function lockManager(): LockManager | null {
  if (typeof navigator === 'undefined') return null;
  const manager = (navigator as Navigator & { locks?: LockManager | null }).locks;
  return manager && typeof manager.request === 'function' ? manager : null;
}
