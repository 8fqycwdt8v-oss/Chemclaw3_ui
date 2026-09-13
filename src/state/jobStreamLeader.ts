/**
 * One tab holds the job-completion streams; the others read what it saw.
 *
 * ## The problem this solves, and the one it must not create
 *
 * `service_max_event_streams_per_user` is **5**, enforced per principal per process, and it has no
 * idea what a tab is. `useJobStreams` budgets 3, which fits one tab and not two: a chemist with two
 * windows asks for six, the sixth 429s, and the contained degradation drops a tab to a single
 * stream for the life of the page. Nothing client-side could see the other tab's usage, because the
 * count lives in the pod's memory.
 *
 * `ISSUES.md` #6 filed this rather than half-building it, for a reason worth repeating at the top
 * of the file that finally builds it: **a botched election loses notifications, which is strictly
 * worse than watching fewer conversations.** A durable job runs for minutes to hours; its
 * completion arrives once, on a stream that must be open. So every decision below is made in favour
 * of *someone* holding the streams rather than in favour of never having two.
 *
 * ## What is elected, and how
 *
 * A campaign, not a lock. A tab that wants to lead broadcasts a `claim` and waits `ELECTION_MS`;
 * it becomes leader only if no `heartbeat` arrived (somebody already leads) and no competing
 * `claim` carried a smaller id. Ids are random and compared as strings, so two tabs opening in the
 * same millisecond resolve deterministically in one round trip rather than both winning and
 * discovering it later.
 *
 * The leader then heartbeats every `HEARTBEAT_MS`. A follower that has heard nothing for
 * `LEASE_MS` starts its own campaign. That is the whole recovery path, and it is deliberately the
 * same one for every way a leader can vanish:
 *
 *  - **Closed.** `pagehide` broadcasts `resign`, and every follower campaigns at once rather than
 *    waiting out the lease. Takeover is one election window.
 *  - **Crashed, or killed by the OS.** No `resign` — nothing runs. The lease expires and a
 *    follower campaigns. This is why the lease exists at all: `beforeunload` is not a guarantee,
 *    and a design that depended on it would lose every notification after a crash.
 *  - **Suspended or backgrounded.** Identical to a crash from outside: a frozen tab's timers do not
 *    run, so its heartbeats stop and the lease expires. What makes this case different is that it
 *    can come *back*, still believing it leads — which is the two-leader case below.
 *
 * **Two leaders is expected, not prevented.** A woken tab heartbeats; whichever leader has the
 * larger id sees the other's heartbeat and steps down. So the invariant is "two leaders converge to
 * one within a heartbeat", not "two leaders cannot happen" — and the cost while it lasts is the
 * ordinary over-cap 429 that `useJobStreams` already contains.
 *
 * **No `BroadcastChannel` at all** — an old browser, or a context that does not expose one — makes
 * every tab a leader. That is exactly today's behaviour, and today's behaviour is safe: the 429
 * path handles it. A feature that degraded to "nobody watches" would be the one unacceptable
 * outcome.
 *
 * ## What is watched, which is not what the leader wants
 *
 * Electing a leader is only half a design, and the missing half loses notifications quietly enough
 * that it would have shipped. `watchedSessionKey` reads *this* tab's `conversations` and *this*
 * tab's `activeId`; neither is shared, because the store is hydrated per tab and an active
 * conversation is by definition per window. So a leader that simply held its own three streams
 * would leave the other window's conversation watched by nobody in the account — the exact loss
 * this file exists to prevent, arriving from the direction the election does not look in. Driven
 * before this existed: the account held one stream, for the leader's own session, and the
 * follower's conversation was watched by nothing.
 *
 * So every tab `declare`s what it wants and the leader watches the **merge**, round-robin by rank
 * (`mergeWatchSets`), capped at the account's budget rather than at any tab's. A follower's
 * periodic message *is* its interest — one message per second per role — and an interest expires on
 * the same `LEASE_MS` as leadership, so a crashed tab stops holding a slot for a window nobody is
 * looking at.
 *
 * ## What is relayed
 *
 * The leader `publish`es what its streams saw and the followers apply it. Two properties make that
 * sound rather than hopeful: the store's own handlers are idempotent (`pushJobFinished` keeps the
 * original item for a repeated `job_id`, `noteAwaiting` is keyed on `request_id`), so a note
 * delivered twice is not a second card; and the stream health goes over the same channel, because a
 * follower holds no streams and would otherwise show a chemist no warning while notifications were
 * in fact failing. A tab that joins later gets that health replayed when its claim is answered.
 *
 * **The gap during a takeover is a delay, not a loss.** The service writes job endings into
 * `session_events` and a reader claims them; a row nobody has claimed is still there when the next
 * stream opens. So what a takeover costs is the seconds until somebody reconnects.
 */

import type { AwaitingAnswerEvent, JobTerminalEvent } from '../../shared/events.ts';

/**
 * The channel name. One per origin; the browser scopes it for us.
 *
 * Exported so `tests/jobStreamElection.test.ts` can script a peer tab on the same channel. It is
 * not an assertion target — nothing is checked against it — it is the address two tabs of this app
 * have to agree on, and a rename that moved both is a rename that changed nothing.
 */
export const CHANNEL = 'chemclaw.job-streams';

/**
 * How long a campaigning tab listens before declaring itself leader.
 *
 * It only has to cover a same-origin `postMessage` round trip, which is microseconds — this is
 * generous so that a tab doing heavy work at startup (this one parses a persisted store and
 * hydrates auth) still answers a claim in time.
 */
const ELECTION_MS = 250;

/** How often the leader says it is still here. */
const HEARTBEAT_MS = 1_000;

/**
 * Silence that means the leader is gone.
 *
 * Three heartbeats, so a single missed timer — a busy main thread, a throttled background tab that
 * is still alive — does not start an election. The cost of being wrong in this direction is a
 * takeover nobody needed; the cost in the other is the whole feature going quiet, so the margin is
 * on the side of electing.
 */
const LEASE_MS = 3 * HEARTBEAT_MS;

/** What a leader tells the other tabs. Everything here is structured-clone safe. */
export type Note =
  | { kind: 'job'; event: JobTerminalEvent; sessionId: string }
  | { kind: 'awaiting'; event: AwaitingAnswerEvent }
  | { kind: 'health'; failing: readonly string[]; throttled: boolean };

type Message =
  | { type: 'claim'; from: string }
  | { type: 'heartbeat'; from: string }
  | { type: 'resign'; from: string }
  | { type: 'interest'; from: string; sessions: readonly string[] }
  | { type: 'note'; from: string; note: Note };

/**
 * The account's watch set, out of what each tab asked for.
 *
 * **Round-robin by rank, not concatenation**, and that is the whole of it. Every tab's list arrives
 * already in its own priority order (its active conversation first — see `watchedSessionKey`), so
 * taking rank 0 from every tab before rank 1 from any of them gives each window the conversation
 * it is actually looking at, for as many windows as the budget has room for. Concatenating would
 * spend the entire budget on the leader's own list and leave every other window watching nothing,
 * which is the failure this whole file exists to prevent, arriving from the other direction.
 *
 * `mine` goes first at each rank so the tab holding the streams breaks its own ties, which makes
 * the result a function of the inputs rather than of message arrival order.
 *
 * Exported for `tests/jobStreamElection.test.ts`, which drives the ordering directly: the wiring
 * tests can only see the first three of a six-way merge.
 */
export function mergeWatchSets(
  mine: readonly string[],
  peers: readonly (readonly string[])[],
  budget: number,
): string[] {
  const lists = [mine, ...peers];
  const merged: string[] = [];
  const depth = Math.max(...lists.map((list) => list.length));
  for (let rank = 0; rank < depth && merged.length < budget; rank += 1) {
    for (const list of lists) {
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
   * What this tab wants watched, in its own priority order, and how many the account may hold.
   *
   * Told to every tab rather than only to the leader, because the leader can change without any
   * tab's interest changing, and a takeover that had to ask would watch nothing until it did.
   */
  declare(sessions: readonly string[], budget: number): void;
  /**
   * What this tab must actually open. Empty for a follower; for a leader, the merge of every live
   * tab's `declare`, capped at the leader's own budget.
   */
  watched(): readonly string[];
  /** Called whenever either answer changes, so a React hook can re-render. Returns an
   *  unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Apply a note here and send it to the other tabs. Only the leader has anything to publish. */
  publish(note: Note): void;
  /**
   * Leave.
   *
   * `announce: false` is how a tab that **died** is driven — no `resign`, nothing cleaned up on the
   * other side, which is the case `pagehide` cannot cover and the lease exists for. It is not a
   * production path and says so; `close()` with no argument is.
   */
  close(options?: { announce?: boolean }): void;
}

/** A short, comparable, unguessable id. Comparison decides elections, so it must be total. */
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
    // The one payload a tab acts on structurally — it decides which streams get opened — so the
    // array is checked rather than trusted. A note is handed to the caller as-is, because the only
    // sender is another copy of this app and the store's own handlers already normalise.
    const { sessions } = data as { sessions?: unknown };
    return Array.isArray(sessions) && sessions.every((s) => typeof s === 'string');
  }
  return type === 'claim' || type === 'heartbeat' || type === 'resign' || type === 'note';
}

/**
 * Join the election.
 *
 * `deliver` is what a note *means*, and it is the caller's because this module owns the election
 * and the channel and nothing about the store. It is called for the leader's own notes too, so
 * there is exactly one path from "a frame arrived" to "the store changed" and a follower cannot
 * diverge from a leader by construction.
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
  // No channel, no election: every tab leads, which is what this app did before there was an
  // election at all. Said in the module docstring and worth the explicit branch here, because the
  // alternative — treating "cannot coordinate" as "must not watch" — would turn a missing browser
  // API into silence about a job a chemist is waiting on.
  if (!channel) {
    return {
      id,
      isLeader: () => true,
      declare: (sessions, nextBudget) => {
        mine = sessions;
        budget = nextBudget;
        notify();
      },
      // Its own, capped by its own budget. There are no peers to merge, which is the same answer
      // `mergeWatchSets` gives for an empty peer list — written through it anyway, so a tab with no
      // `BroadcastChannel` and a tab that is simply alone cannot drift apart.
      watched: () => mergeWatchSets(mine, [], budget),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      publish: (note) => deliver(note),
      close: () => undefined,
    };
  }

  let campaign: ReturnType<typeof setTimeout> | null = null;
  /** Claims heard during the current campaign. The smallest id wins. */
  let rivals: string[] = [];
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lastHeard = 0;
  /**
   * What the other tabs asked for, and when they last said so.
   *
   * Expiry is the same `LEASE_MS` as leadership, for the same reason and against the same clock: a
   * follower re-announces on every watchdog tick, so a claim on a stream survives three missed
   * announcements and no more. Without it a crashed tab's interest would outlive the tab — the
   * leader holding a stream for a window nobody is looking at, inside a budget of three, which at
   * the limit is the live window watching nothing. A follower that *closes* is covered sooner by
   * nothing at all: there is no `leave` message, deliberately, because the expiry already handles
   * the case that cannot send one and a second mechanism for the case that can is a second thing
   * to get wrong.
   */
  const asked = new Map<string, { sessions: readonly string[]; at: number }>();
  let watched: readonly string[] = [];

  const now = (): number => Date.now();

  /** Recompute the watch set, dropping tabs that have gone quiet. Returns whether it moved. */
  const rebuild = (): boolean => {
    let next: readonly string[] = [];
    if (leader) {
      const cutoff = now() - LEASE_MS;
      for (const [peer, interest] of asked) if (interest.at <= cutoff) asked.delete(peer);
      const peers = [...asked.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([, interest]) => interest.sessions);
      next = mergeWatchSets(mine, peers, budget);
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

  const beat = (): void => send({ type: 'heartbeat', from: id });

  const win = (): void => {
    campaign = null;
    if (closed || leader) return;
    // The smallest id campaigning wins, so two tabs that opened together agree without a second
    // round. A rival that also lost simply waits out the lease, as it would for any silence.
    if (rivals.some((rival) => rival < id)) {
      // Losing counts as hearing from the winner: it gets a full lease to prove itself before
      // anybody campaigns again.
      lastHeard = now();
      rivals = [];
      return;
    }
    rivals = [];
    setLeader(true);
    beat();
    heartbeatTimer ??= setInterval(beat, HEARTBEAT_MS);
  };

  const stand = (): void => {
    if (closed || leader || campaign !== null) return;
    rivals = [];
    send({ type: 'claim', from: id });
    campaign = setTimeout(win, ELECTION_MS);
  };

  const standDown = (): void => {
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    setLeader(false);
    // Say what this tab wants on the way down. The tab that deposed it has never heard from this
    // one — it was leading, and a leader announces nothing — so without this the conversation in
    // *this* window goes unwatched until the next watchdog tick.
    announce();
  };

  channel.addEventListener('message', (event) => {
    const message = (event as MessageEvent).data;
    if (closed || !isMessage(message) || message.from === id) return;

    switch (message.type) {
      case 'claim':
        rivals.push(message.from);
        if (leader) {
          // Answer at once rather than at the next tick: the newcomer's campaign is shorter than
          // the heartbeat interval, so a leader that waited would let it win and make two.
          beat();
          if (health) send({ type: 'note', from: id, note: health });
        } else {
          // Somebody may be about to start holding the streams. Every leadership change begins
          // with a claim, so answering one is what makes a takeover inherit the account's whole
          // watch set instead of rebuilding it a tick at a time.
          announce();
        }
        break;
      case 'heartbeat':
        lastHeard = now();
        // Somebody already leads, so stop campaigning against them.
        if (campaign !== null) {
          clearTimeout(campaign);
          campaign = null;
          rivals = [];
        }
        // Two leaders, which a suspended tab waking up produces by itself. The larger id yields —
        // a total order, so exactly one of the pair steps down and it is the same one on both
        // sides.
        if (leader && message.from < id) standDown();
        break;
      case 'resign':
        // Do not wait out the lease for a departure we were told about.
        lastHeard = 0;
        // Whatever it was holding for this tab, it is not holding any more.
        asked.delete(message.from);
        stand();
        break;
      case 'interest':
        asked.set(message.from, { sessions: message.sessions, at: now() });
        if (leader && rebuild()) notify();
        break;
      case 'note':
        deliver(message.note);
        break;
    }
  });

  // The watchdog. One timer for the life of the tab, rather than one armed per lease: a tab that is
  // frozen and thawed resumes checking on the same schedule instead of firing a pile of expired
  // timeouts at once.
  const watchdog = setInterval(() => {
    if (closed) return;
    if (leader) {
      // The leader's own tick does the expiring: a tab that has stopped announcing stops being
      // counted, and the slot it held goes to somebody who is still here.
      if (rebuild()) notify();
      return;
    }
    // A follower's periodic message *is* its interest, which is why there is no separate keepalive:
    // one message per second per role, and the thing it carries is the thing the leader needs.
    announce();
    if (now() - lastHeard > LEASE_MS) stand();
  }, HEARTBEAT_MS);

  // `pagehide` rather than `beforeunload`: it fires on mobile Safari's app switch and on the way
  // into the back/forward cache, both of which are exactly the "this tab is going away" this needs
  // — and `beforeunload` is documented as unreliable on all of them. A tab that comes back out of
  // the cache is an ordinary follower whose watchdog will take over if nobody else did.
  const onHide = (): void => {
    if (leader) send({ type: 'resign', from: id });
  };
  if (typeof addEventListener === 'function') addEventListener('pagehide', onHide);

  stand();

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
      if (options?.announce !== false && leader) send({ type: 'resign', from: id });
      if (campaign !== null) clearTimeout(campaign);
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      clearInterval(watchdog);
      if (typeof removeEventListener === 'function') removeEventListener('pagehide', onHide);
      // A crashed tab is modelled by leaving the channel *open* and silent, because that is what a
      // crash looks like from the other side: the port is gone with the process, and nothing is
      // ever sent again. Closing it here would be tidier and would model nothing.
      if (options?.announce !== false) channel.close();
      setLeader(false);
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
