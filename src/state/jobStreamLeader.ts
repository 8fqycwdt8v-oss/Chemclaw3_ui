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
 * **A lock the browser holds, not a campaign this file runs.** Every tab asks for the same
 * `navigator.locks.request(LOCK, { mode: 'exclusive' }, …)` at startup; exactly one callback runs
 * and the rest sit in the browser's own queue. Leadership *is* holding that lock, so there is no
 * claim, no heartbeat, no lease, no id comparison and no watchdog for any of it.
 *
 * This file used to run all of that by hand — ~150 lines of `ELECTION_MS`/`HEARTBEAT_MS`/`LEASE_MS`
 * timers, a `claim`/`heartbeat`/`resign` protocol, and a convergence rule for the two leaders it
 * could not prevent. What replaced it costs **zero bytes** (Web Locks is baseline in every browser
 * this app targets) and is *stronger* rather than merely smaller, because the one thing a
 * lease-and-heartbeat design cannot do is notice that a tab has stopped existing:
 *
 *  - **Closed, crashed, or killed by the OS.** The lock is released by the browser when the
 *    context goes away, and the next tab in the queue is running before anything on this side
 *    could have measured a missed heartbeat. Takeover is immediate in all three, where the crash
 *    and kill cases used to cost a full `LEASE_MS` of silence — `beforeunload` is not a guarantee,
 *    which is exactly why the old design needed a lease *as well as* a `resign`.
 *  - **Frozen, or in the back/forward cache.** The one case the kernel does *not* cover: a frozen
 *    tab is alive and still holds its lock while reading nothing. So `pagehide` *and* `freeze`
 *    release it, and `pageshow` and `resume` ask again — two pairs rather than one, because they
 *    are different events for different states and neither implies the other: `pagehide` fires on
 *    unload and on the way into the back/forward cache, `freeze` fires on a tab the browser froze
 *    in place and does not fire `pagehide` for. Asking again re-queues the restored tab behind
 *    whoever took over meanwhile, which is the same handover as any other.
 *  - **Merely backgrounded.** Nothing happens, and that is the improvement. A throttled tab's
 *    timers are clamped but its streams are not, so the old lease expired against a leader that
 *    was still working and cost the account a takeover — a close and a reopen of every stream —
 *    for nothing. There is no lease to expire now.
 *
 * **Two leaders cannot happen**, which is a thing this file used to have to reason about rather
 * than assert: the old invariant was "two leaders converge to one within a heartbeat", because a
 * suspended tab waking up produced a second one by itself. Exclusivity is now the browser's, held
 * across tabs of the origin, so the convergence rule and the case it existed for are both gone.
 *
 * **No `BroadcastChannel`, or no `navigator.locks`** — an old browser, or a context that exposes
 * neither — makes every tab a leader. That is exactly the behaviour this app had before there was
 * an election at all, and it is safe: the 429 path handles it. A feature that degraded to "nobody
 * watches" would be the one unacceptable outcome, so "cannot coordinate" resolves to "watch my
 * own", never to "watch nothing". One branch covers both missing APIs, because a tab that cannot
 * take the lock and a tab that cannot hear its peers are the same tab as far as this file's one
 * safety rule is concerned.
 *
 * **What this gives up, stated rather than implied.** A heartbeat is evidence that a tab is
 * *running*; a held lock is only evidence that its context still exists. So a leader whose main
 * thread is wedged — an infinite loop, a pathological synchronous parse — keeps the lock and reads
 * nothing, where the old lease would have deposed it within 3 s. Every other way a tab stops
 * running ends in a released lock or in one of the two lifecycle events above. The trade was taken
 * knowing that, because the lease's own false positives were the commoner fault by a long way: it
 * could not tell a wedged tab from a merely throttled one either, and it deposed both.
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
 * (`mergeWatchSets`), capped at the account's budget rather than at any tab's — and rotated over
 * time once there are more interested tabs than the budget has room for, because rank 0 alone
 * leaves the tabs past position `budget - 1` watched by nobody in the account, deterministically
 * and for ever. A follower's periodic message *is* its interest — one message per second per role
 * — and an interest expires on `INTEREST_LEASE_MS`, which is deliberately far longer than the
 * leadership lease, so that a backgrounded window whose timers the browser has clamped to once a
 * minute keeps the slot it is the whole point of this feature to give it.
 *
 * ## What is relayed
 *
 * The leader `publish`es what its streams saw and the followers apply it. Two properties make that
 * sound rather than hopeful: the store's own handlers are idempotent (`pushJobFinished` keeps the
 * original item for a repeated `job_id`, `noteAwaiting` is keyed on `request_id`), so a note
 * delivered twice is not a second card; and the stream health goes over the same channel, because a
 * follower holds no streams and would otherwise show a chemist no warning while notifications were
 * in fact failing. A tab that joins later gets that health replayed in answer to its `hello`.
 *
 * **The gap during a takeover is a delay for every row nobody has claimed, and a loss for the one
 * already in flight.** The service writes job endings into `session_events` and a reader claims
 * them, so a row nobody has claimed is still there when the next stream opens: that is what makes a
 * takeover — and the rotation above — cost seconds rather than a notification.
 *
 * The claim is destructive, though, and it bounds the promise rather than fulfilling it. Upstream's
 * `claim_unconsumed` is one `UPDATE … FOR UPDATE SKIP LOCKED … RETURNING`, at-most-once by design,
 * with `restore_unconsumed` un-claiming only a row whose *yield* never completed — so a row already
 * written to the departing tab's socket is gone from the mailbox. A tab that dies between reading
 * that frame and `publish`ing it loses it for every window on the account, and no reconnect brings
 * it back. Nothing on this side can close that: the fix is an acknowledgement upstream, and
 * `ISSUES.md` Issue 12 records it. This paragraph read "a delay, not a loss" flatly, which made the
 * one case this file cannot cover the one case it claimed to.
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
 * The Web Lock whose holder is the leader.
 *
 * A separate string from `CHANNEL` even though the two could share one: lock names and channel
 * names are different namespaces, and a reader who saw one constant used for both would have to
 * work out whether that was load-bearing. It is not, and this says so by not doing it.
 *
 * Exported so `tests/jobStreamElection.test.ts`'s lock stand-in can be driven on the same name
 * the shipped code asks for.
 */
export const LOCK = 'chemclaw.job-streams.leader';

/**
 * How often a follower re-states what it wants watched.
 *
 * This is now the module's **only** timer, and it belongs entirely to the interest protocol — the
 * leadership half used to own three more (`ELECTION_MS`, `HEARTBEAT_MS`, `LEASE_MS`) and the
 * browser owns that now. A follower's periodic message *is* its interest, so one message per
 * second per tab carries both the keepalive and the thing the leader needs.
 */
const ANNOUNCE_MS = 1_000;

/**
 * Silence that means a tab has stopped wanting what it asked for.
 *
 * **This is the only lease left, and it survived the change that deleted the other one for a
 * reason worth keeping written down: the two expired against different clocks.** Leadership had to
 * expire when a tab's timers stopped, and that is exactly what made it the wrong tool — a merely
 * throttled leader is still reading its streams, so the lease was as likely to depose a working tab
 * as a dead one. The browser answers that question directly now. An interest is the opposite, and
 * cannot be delegated to anything: nothing but the tab itself knows what it wants. A backgrounded
 * window is precisely the one whose job notifications matter, and a browser clamps a hidden tab's
 * timers hard: ≥1 s everywhere, and Chrome's *intensive throttling* drops a hidden tab to **one
 * timer callback a minute** after about five minutes. A follower re-announces from the 1 Hz
 * watchdog, so at that clamp a three-second expiry means its interest is dead for 57 seconds of
 * every 60. Driven before this constant existed, with a peer announcing once a minute and the
 * leader sampled every 500 ms over three minutes: **342 of 360 samples had the follower's
 * conversation watched by nobody**, and every recovery cost a fresh connect, spent against the very
 * cap this file exists to respect.
 *
 * Five minutes, which is four missed announcements at the clamped rate and 300 at the unclamped
 * one. What it costs is a tab that died holding a slot for up to five minutes, and two things pay
 * for that: a tab that leaves *politely* says so on the way out (see
 * `onHide` and `close`, which announce an empty interest), and a stale slot no longer starves
 * anybody outright now that `mergeWatchSets` rotates — it wastes one of the account's streams for
 * one lease rather than making a live window dark for ever.
 *
 * Exported for the same reason as `ROTATION_MS`: a test that advances its own transcription of
 * this number goes green if the number changes underneath it.
 */
export const INTEREST_LEASE_MS = 5 * 60 * 1_000;

/** What a leader tells the other tabs. Everything here is structured-clone safe. */
export type Note =
  | { kind: 'job'; event: JobTerminalEvent; sessionId: string }
  | { kind: 'awaiting'; event: AwaitingAnswerEvent }
  | { kind: 'health'; failing: readonly string[]; throttled: boolean };

/**
 * What tabs say to each other. Three of the five members were the election and are gone;
 * `hello` is what took their one *other* job.
 *
 * A `claim` used to do two unrelated things — start a campaign, and make every other tab restate
 * itself so that a takeover inherited the account's whole watch set rather than rebuilding it a
 * tick at a time. The campaign is the browser's now; the restating still has to happen, and it has
 * to happen at both of the moments the old `claim` covered: a tab arriving (which needs the
 * current stream health, which only the leader has) and a tab *becoming* leader (which needs every
 * other tab's interest, which it has never heard — a leader announces nothing). `hello` is one
 * message for both, because both are the same request: tell me the picture I was not here for.
 */
type Message =
  | { type: 'hello'; from: string }
  | { type: 'interest'; from: string; sessions: readonly string[] }
  | { type: 'note'; from: string; note: Note };

/**
 * How long one arrangement of the account's watch set stands before the merge rotates it.
 *
 * Only reached when there are more interested tabs than the budget has room for — see
 * `mergeWatchSets` — so in the ordinary one- and two-window case this constant changes nothing and
 * costs no connect. Past that it is the period at which a dark window becomes a watched one.
 *
 * A minute, from the two costs it sits between. Rotating faster spends connects against the very
 * per-principal cap this whole file exists to respect (each step closes one stream and opens
 * another). Rotating slower leaves a window dark for longer — and that wait is the *whole* cost,
 * because it is a delay rather than a loss: the service writes job endings into `session_events`
 * and a reader claims them, so the rows a window missed while it was dark are still there when its
 * turn comes round. That is the same property the takeover paragraph above rests on, used here for
 * the same reason. Against a durable run that takes minutes to hours, a minute of latency on its
 * completion card is not a failure a chemist can measure; being dark for ever is.
 *
 * Exported so `tests/jobStreamElection.test.ts` can advance a clock by it rather than transcribe
 * it — a test that hardcoded 60_000 would go quietly green if this were raised to an hour.
 */
export const ROTATION_MS = 60_000;

/**
 * The account's watch set, out of what each tab asked for.
 *
 * **Round-robin by rank, not concatenation**, and that is most of it. Every tab's list arrives
 * already in its own priority order (its active conversation first — see `watchedSessionKey`), so
 * taking rank 0 from every tab before rank 1 from any of them gives each window the conversation
 * it is actually looking at, for as many windows as the budget has room for. Concatenating would
 * spend the entire budget on the leader's own list and leave every other window watching nothing,
 * which is the failure this whole file exists to prevent, arriving from the other direction.
 *
 * **And rank 0 is not enough on its own, which is what `turn` is for.** Round-robin by rank is
 * round-robin *within one merge*; with more interested tabs than the budget, the tabs past
 * rank-0 position `budget - 1` appear at no rank at all, and since the peer order is a sort on a
 * stable random id, it is the *same* tabs every time, for the life of the page. Driven at budget 3
 * with six interested tabs, the same three sessions came back at t=0.5 s and at t=6 min and the
 * other three were watched by nobody in the account — which is precisely the "nobody watches"
 * outcome the module docstring names as the one unacceptable one, and it is worse than what this
 * file replaced (a fourth window used to 429 and still watch its own conversation). So when the
 * interested tabs outnumber the budget the whole order is rotated by `turn`, and every window's
 * first choice is watched for its share of the time instead of never.
 *
 * **Only then.** Where everybody's first choice fits, `turn` changes nothing: rotating a set that
 * is not starved would move sessions in and out of the watch set — a connect and a disconnect per
 * step — to fix a starvation that is not happening. Two windows at a budget of three keep exactly
 * the set they had before this parameter existed.
 *
 * `mine` goes first at each rank (at `turn` 0, and at every `turn` while nothing is starved) so the
 * tab holding the streams breaks its own ties, which makes the result a function of the inputs
 * rather than of message arrival order.
 *
 * An empty list is a tab that wants nothing — a window with no conversation yet, or one that said
 * so on its way out. It contributes at no rank, so it is dropped before the rotation rather than
 * being given a step of its own.
 *
 * Exported for `tests/jobStreamElection.test.ts`, which drives the ordering directly: the wiring
 * tests can only see the first three of a six-way merge.
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
   * `announce: false` is how a tab that **died** is driven — nothing said on the channel, nothing
   * cleaned up on the other side, which is the case `pagehide` cannot cover. The Web Lock is still
   * released, because that is the browser's doing rather than the tab's and a crash releases it:
   * withholding it would model a crash no browser produces. It is not a production path and says
   * so; `close()` with no argument is.
   */
  close(options?: { announce?: boolean }): void;
}

/**
 * A short, unguessable id for this tab.
 *
 * It no longer decides anything — id comparison was how the old campaign broke a tie and how two
 * leaders picked which one stepped down, and the browser does both now. What is left is identity:
 * it keys this tab's row in the leader's interest map, it is how a tab ignores its own broadcasts,
 * and it breaks ties in `mergeWatchSets` so the merged set is a function of its inputs rather than
 * of message arrival order.
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
    // The one payload a tab acts on structurally — it decides which streams get opened — so the
    // array is checked rather than trusted. A note is handed to the caller as-is, because the only
    // sender is another copy of this app and the store's own handlers already normalise.
    const { sessions } = data as { sessions?: unknown };
    return Array.isArray(sessions) && sessions.every((s) => typeof s === 'string');
  }
  return type === 'hello' || type === 'note';
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
  const locks = lockManager();
  // No channel or no lock manager, no election: every tab leads, which is what this app did before
  // there was an election at all. Said in the module docstring and worth the explicit branch here,
  // because the alternative — treating "cannot coordinate" as "must not watch" — would turn a
  // missing browser API into silence about a job a chemist is waiting on.
  //
  // One branch for both, rather than a half-coordinated third mode: a tab that can hear its peers
  // but cannot take the lock would have to *agree* with them about who leads, which is the hand-run
  // election this change deletes. And the third mode would be worse than useless — every tab
  // leading while also merging every other tab's interest means every tab opens the same set, which
  // spends the account's whole budget several times over against the very cap this file exists to
  // respect.
  if (!channel || !locks) {
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

  /**
   * How this tab gives the lock back, or `null` when it does not hold it.
   *
   * Resolving the promise the lock callback returned is the *only* way to release a Web Lock —
   * there is no handle to call `release()` on — so the resolver is kept here and calling it is
   * what standing down means. The browser calls it for us when the context dies, which is the
   * whole reason the lease is gone.
   */
  let release: (() => void) | null = null;
  /** Is a `locks.request` queued or running? Stops `pageshow` queueing a second one behind the
   *  first, which would leave this tab holding the lock twice and releasing it once. */
  let requested = false;
  /**
   * What the other tabs asked for, and when they last said so.
   *
   * Expiry is `INTEREST_LEASE_MS` — see that constant for the measurement, and for why it did not
   * go the way the leadership lease did. Without any expiry a crashed tab's interest would outlive
   * the tab: the leader holding a stream for a window nobody is looking at, inside a budget of
   * three.
   *
   * A follower that *closes* does not wait it out. There is still no `leave` message, because the
   * message that says a tab wants nothing is the one that already says what a tab wants: an
   * `interest` carrying no sessions, which replaces what that tab asked for before and so frees
   * its slot on the next rebuild. That is what makes a five-minute expiry affordable — the expiry
   * now covers only the tab that *cannot* speak, which is the case it was always for.
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
      // The rotation step comes off the clock rather than off a counter, so it advances once a
      // minute however often `rebuild` runs — it runs on every watchdog tick and on every interest
      // message, and a per-call counter would rotate the account's streams several times a second.
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
   * Queue for the streams, and hold them until this tab gives them back.
   *
   * The callback runs when the lock is granted and the lock is held for as long as the promise it
   * returns is pending — so the promise is one this tab resolves, and resolving it is the handover.
   * Every tab calls this once at startup; the followers are simply the ones whose callback has not
   * run yet, which is why there is nothing here that looks like waiting.
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
          // A leader announces nothing, so this tab has never heard what the others want. Ask, at
          // once rather than on the next tick: a takeover that waited would watch only its own
          // conversation for a second, which for the window that just lost its leader is the exact
          // gap this file exists to close.
          send({ type: 'hello', from: id });
        });
      })
      .catch(() => {
        // The request itself failed — a partitioned context, a manager going away under us. Lead
        // anyway, on the module's one safety rule: someone holding the streams beats nobody, and
        // the 429 path contains the cost of being one of two.
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
        // Symmetric by role, because the two things a tab can be missing are held by different
        // tabs: the leader has the stream health nobody else can observe, and the followers have
        // the interests the leader has never been told. Each answers with the half it owns.
        if (leader) {
          if (health) send({ type: 'note', from: id, note: health });
        } else {
          announce();
        }
        break;
      case 'interest':
        // An interest carrying nothing is a tab saying it wants nothing — a window with no
        // conversation yet, or one on its way out — and it is stored as one rather than special-
        // cased, because what makes it free the slot is that it *replaces* what that tab asked for
        // before. `mergeWatchSets` drops an empty list, so a deletion here would be a second
        // mechanism for an effect that already has one, indistinguishable from this in every
        // observable way: driven both ways, the same tests pass.
        asked.set(message.from, { sessions: message.sessions, at: now() });
        if (leader && rebuild()) notify();
        break;
      case 'note':
        deliver(message.note);
        break;
    }
  });

  // One timer for the life of the tab. It used to carry the lease check as well; what is left is
  // only the interest protocol, on each side of it.
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

  // `pagehide` rather than `beforeunload`: it fires on mobile Safari's app switch and on the way
  // into the back/forward cache, both of which are exactly the "this tab is going away" this needs
  // — and `beforeunload` is documented as unreliable on all of them.
  //
  // A leader **must** release here, and this is the one case the browser does not cover for us. A
  // frozen or bfcached tab has not gone away: it is alive, it still holds the lock, and it is
  // reading nothing. Left alone it would be a leader nobody can depose, which is the failure the
  // old lease existed to prevent — so the lease is not gone so much as narrowed to the single
  // event that actually signals it.
  const onHide = (): void => {
    if (leader) standDown();
    // A follower has nothing to release and, since `INTEREST_LEASE_MS` is five minutes, everything
    // to say: without this its slot is held for a window that is gone.
    else send({ type: 'interest', from: id, sessions: [] });
  };
  // And the other half: a tab restored from the cache asks again, joining the back of whatever
  // queue formed while it was frozen. Without this, releasing on `pagehide` would mean a restored
  // tab could never lead again — strictly worse than the lease it replaces.
  const onShow = (): void => {
    if (!closed && !leader) takeTheStreams();
  };
  if (typeof addEventListener === 'function') {
    // Two pairs, because they are different states: `pagehide`/`pageshow` is unload and the
    // back/forward cache, `freeze`/`resume` is a tab the browser froze in place — which does not
    // fire `pagehide`, and which is therefore the case a one-pair version would leave holding a
    // lock nobody can take.
    for (const event of ['pagehide', 'freeze']) addEventListener(event, onHide);
    for (const event of ['pageshow', 'resume']) addEventListener(event, onShow);
  }

  takeTheStreams();
  // Pull whatever this tab was not here for. A leader answers with the stream health it is the
  // only tab able to observe; if this tab is itself about to win the lock, its own `hello` on the
  // way in is a no-op that costs one same-origin message.
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
        // A follower says its slot is free; a leader has nothing to *say*, because giving the lock
        // back is the message. That asymmetry is new: `resign` used to exist only because a
        // departure had to be announced or waited out, and the browser announces this one.
        if (!leader) send({ type: 'interest', from: id, sessions: [] });
      }
      clearInterval(watchdog);
      if (typeof removeEventListener === 'function') {
        for (const event of ['pagehide', 'freeze']) removeEventListener(event, onHide);
        for (const event of ['pageshow', 'resume']) removeEventListener(event, onShow);
      }
      // A crashed tab is modelled by leaving the channel *open* and silent, because that is what a
      // crash looks like from the other side: the port is gone with the process, and nothing is
      // ever sent again. Closing it here would be tidier and would model nothing.
      if (options?.announce !== false) channel.close();
      // The lock is released either way, and that is not the announcement half leaking into the
      // silent one — it is the browser's job, and the browser does it for a tab that crashes. A
      // `close({ announce: false })` that kept the lock would model a crash no browser produces:
      // one where the dead tab's lock outlives it and no other tab can ever lead.
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

/**
 * `navigator.locks`, or `null` where there is none.
 *
 * Read through `typeof` and a null check rather than `'locks' in navigator`, because the property
 * exists and is `null` in at least one environment this repository runs in (happy-dom), and `in`
 * would hand a `null` to `.request` at the first handover instead of taking the fallback the module
 * docstring promises.
 */
function lockManager(): LockManager | null {
  if (typeof navigator === 'undefined') return null;
  const manager = (navigator as Navigator & { locks?: LockManager | null }).locks;
  return manager && typeof manager.request === 'function' ? manager : null;
}
