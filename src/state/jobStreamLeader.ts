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
  | { type: 'note'; from: string; note: Note };

/** One tab's membership of the election. */
export interface StreamLeader {
  /** This tab's identity in the election. Exposed because every failure mode above is about which
   *  tab is which, and a test that cannot name them cannot assert on them. */
  readonly id: string;
  /** Does this tab hold the streams? */
  isLeader(): boolean;
  /** Called whenever that answer changes, so a React hook can re-render. Returns an unsubscribe. */
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

  const channel = openChannel();
  // No channel, no election: every tab leads, which is what this app did before there was an
  // election at all. Said in the module docstring and worth the explicit branch here, because the
  // alternative — treating "cannot coordinate" as "must not watch" — would turn a missing browser
  // API into silence about a job a chemist is waiting on.
  if (!channel) {
    return {
      id,
      isLeader: () => true,
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

  const now = (): number => Date.now();

  const setLeader = (next: boolean): void => {
    if (leader === next) return;
    leader = next;
    for (const listener of listeners) listener();
  };

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
        stand();
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
    if (closed || leader) return;
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
