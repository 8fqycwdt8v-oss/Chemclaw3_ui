/**
 * W28.8 — `ISSUES.md` #6. One tab holds the job streams, and every way that can go wrong is driven.
 *
 * The issue was filed rather than half-built with a specific reason attached: **a botched election
 * loses notifications**, which is strictly worse than the contained degradation it replaces (a
 * second window's last stream 429s and that tab drops to one). A durable job runs for minutes to
 * hours and its completion arrives once. So the failure modes *are* the work, and this file drives
 * them one at a time rather than asserting that the happy path happens to work.
 *
 * Two tabs are produced two ways, and the difference matters:
 *
 *  - **Two real memberships.** `createStreamLeader` twice, over real `BroadcastChannel`s that
 *    really deliver to each other in this realm. That is the shipped code on both sides, and it is
 *    how the cases about *agreement* are driven.
 *  - **A scripted peer.** A plain channel the test speaks the protocol on, plus a hand on the same
 *    lock. Some of these cases are about a tab that has stopped running — frozen, crashed,
 *    suspended and woken — and a second real membership cannot be made to stop running inside one
 *    event loop. What a scripted peer produces is exactly what the surviving tab *sees*, which is
 *    the only thing the surviving tab's behaviour can depend on.
 *
 * The last two cases leave the module and drive `useJobStreams` itself, because "a follower opens
 * no stream" and "a follower is still told" are properties of the wiring rather than of the
 * election.
 *
 * ## Reworked when the election became a Web Lock
 *
 * The module used to run its own campaign — `claim`/`heartbeat`/`resign`, an election window and a
 * three-second lease — and this file drove every way that could go wrong. It is now
 * `navigator.locks.request(LOCK, { mode: 'exclusive' }, …)` and the browser runs it, so the cases
 * did not go away, they changed what they are *about*:
 *
 *  - "hands over on the resignation rather than on the lease" became "hands over with nothing
 *    announced at all", which is a stronger claim and a shorter wait.
 *  - "is taken over on the lease, because nothing announced anything" became "is taken over at
 *    once, because the browser released the lock" — the case that used to cost `LEASE_MS` of
 *    nobody holding a stream.
 *  - "two leaders converge on one within a heartbeat" became "two leaders cannot happen", which is
 *    the difference between an invariant a file has to maintain and one it can rely on.
 *  - "a leader that has just been deposed says what its window still wants" is **gone with its
 *    subject**: nothing deposes a live leader any more. What replaced it is the back/forward-cache
 *    round trip, which is new code and the one case the browser does not handle for us.
 *
 * `navigator.locks` is `null` under happy-dom, so every case here installs the stand-in in
 * `tests/stubs/webLocks.ts` — see that file for why a suite without it would pass while asserting
 * nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  CHANNEL,
  INTEREST_LEASE_MS,
  LOCK,
  ROTATION_MS,
  createStreamLeader,
  mergeWatchSets,
  type Note,
  type StreamLeader,
} from '../src/state/jobStreamLeader.ts';
import { installLockManager } from './stubs/webLocks.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import { useJobStreams } from '../src/hooks/useJobStreams.ts';
import type { AuthProvider } from '../src/auth/types.ts';

/**
 * Long enough for a membership to have settled: the lock granted (a microtask), the first `hello`
 * delivered and answered, the first interest recorded.
 *
 * It used to have to clear `ELECTION_MS` (250 ms) and stay inside `LEASE_MS` (3 s), and it is
 * generous for what is left. Kept generous deliberately — the thing it is waiting for is now
 * message delivery rather than a timer, and a wait tuned to the fast path is a flake on a loaded
 * machine.
 */
const SETTLED_MS = 400;
/**
 * The bound a *handover* is asserted within, and it is short on purpose.
 *
 * The old version of this constant was 8 s, sized as "the lease, plus the watchdog's own period,
 * plus an election, plus room", and a takeover really did land between 3.0 s and 4.3 s after the
 * last heartbeat. A released lock is granted to the next waiter on a microtask, so 250 ms is not a
 * tight deadline, it is two orders of magnitude of slack — and a case that still needed seconds
 * would be a case where something is waiting that should not be.
 */
const HANDOVER_DEADLINE_MS = 250;
/** Generous upper bound for the cases that wait on a stream, a store write and a re-render rather
 *  than on a handover. */
const DEADLINE_MS = 8_000;

const SID = 'a'.repeat(32);
/** One watchdog tick plus room: what the leader needs to notice a change it was told about. */
const ANNOUNCE_TICK_MS = 1_200;

const jobNote = (jobId: string): Note => ({
  kind: 'job',
  event: { type: 'job_completed', job_id: jobId, summary: {} },
  sessionId: SID,
});

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Every membership this test made, closed in `afterEach` so no heartbeat outlives its case. */
let tabs: StreamLeader[] = [];
let peers: { channel: BroadcastChannel; stop: () => void }[] = [];

interface Tab {
  leader: StreamLeader;
  /** Everything `deliver` was called with, in order. One recorder per tab, which is the only way
   *  to tell "the follower was told" from "the leader told itself". */
  heard: Note[];
}

function openTab(): Tab {
  const heard: Note[] = [];
  const leader = createStreamLeader((note) => heard.push(note));
  tabs.push(leader);
  return { leader, heard };
}

/**
 * A tab this test drives by hand.
 *
 * Leading is now holding the lock rather than sending a heartbeat, so `lead()` takes it and
 * `release()` gives it back — and `release()` is *both* halves of what used to be two cases. A tab
 * that closes politely and a tab that is killed by the OS are the same event from the surviving
 * tab's side now, because the browser releases the lock either way and neither says anything on
 * the channel. `crashWithoutReleasing()` is the one remaining difference and is a *limit* rather
 * than a case: a wedged main thread holds its lock, and nothing here can take it.
 */
function openPeer(id: string): {
  id: string;
  lead: () => Promise<void>;
  release: () => void;
  crashWithoutReleasing: () => void;
  goSilent: () => void;
  hello: () => void;
  keepDeclaring: (sessions: string[], everyMs?: number) => void;
  note: (note: Note) => void;
  received: unknown[];
} {
  const channel = new BroadcastChannel(CHANNEL);
  const received: unknown[] = [];
  channel.addEventListener('message', (event) => received.push((event as MessageEvent).data));
  let timer: ReturnType<typeof setInterval> | null = null;
  let giveBack: (() => void) | null = null;
  const goSilent = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const release = (): void => {
    const resolve = giveBack;
    giveBack = null;
    resolve?.();
  };
  // Registered with its timer, so teardown stops the announcements BEFORE it closes the channel. A
  // surviving interval posting into a closed channel throws out of the timer callback, where
  // nothing can catch it, and vitest reports it against whichever test happened to be running.
  // The lock goes back at the same moment, or the next case starts as a follower of a dead peer.
  peers.push({
    channel,
    stop: () => {
      goSilent();
      release();
    },
  });
  return {
    id,
    // Resolves once this peer *holds* the lock, so a membership opened after it is deterministically
    // a follower. Ordering used to come from comparing ids; it comes from request order now, which
    // is the browser's queue and not something this file can get wrong.
    lead: () =>
      new Promise<void>((held) => {
        void navigator.locks.request(LOCK, { mode: 'exclusive' }, () => {
          held();
          return new Promise<void>((resolve) => {
            giveBack = resolve;
          });
        });
      }),
    release,
    // A tab whose JS stopped without its context going away: no lifecycle event, no release. The
    // one thing the lease covered that a lock does not.
    crashWithoutReleasing: goSilent,
    goSilent,
    hello: () => channel.postMessage({ type: 'hello', from: id }),
    // A live follower, which repeats what it wants watched rather than saying it once. Saying it
    // once is what a *dead* follower looks like, and the module treats the two differently on
    // purpose — so a harness that announced once could not tell them apart either.
    //
    // `everyMs` is how a *throttled* follower is driven. A hidden tab is alive and its watchdog is
    // clamped — ≥1 s everywhere, one callback a minute under Chrome's intensive throttling — which
    // is a third thing, distinct from both the live follower and the dead one, and the shipped
    // interest lease has to tell it from the second.
    keepDeclaring: (sessions, everyMs = 200) => {
      const say = (): void => channel.postMessage({ type: 'interest', from: id, sessions });
      say();
      timer ??= setInterval(say, everyMs);
    },
    note: (note) => channel.postMessage({ type: 'note', from: id, note }),
    received,
  };
}

/** A fresh lock manager per case — see `tests/stubs/webLocks.ts`. Without one, happy-dom's `null`
 *  `navigator.locks` puts every membership on the module's lead-alone fallback and every case
 *  below passes while asserting nothing. */
let restoreLocks: (() => void) | null = null;
beforeEach(() => {
  restoreLocks = installLockManager();
});

afterEach(() => {
  for (const tab of tabs) tab.close();
  tabs = [];
  for (const peer of peers) {
    peer.stop();
    peer.channel.close();
  }
  peers = [];
  restoreLocks?.();
  restoreLocks = null;
});

describe('two tabs opening at the same moment', () => {
  it('agree on exactly one leader, and it is the one that asked first', async () => {
    const a = openTab();
    const b = openTab();

    await wait(SETTLED_MS);

    expect([a.leader.isLeader(), b.leader.isLeader()].filter(Boolean)).toHaveLength(1);
    // Not merely "one of them", and no longer the smaller id: Web Locks is FIFO, so the winner is
    // whichever tab asked first — `a`, unconditionally, which is a stronger assertion than the
    // id comparison it replaces because it does not depend on what `crypto.randomUUID` returned.
    expect(a.leader.isLeader()).toBe(true);
    expect(b.leader.isLeader()).toBe(false);
  });

  it('loses nothing: what the leader publishes reaches the other tab', async () => {
    const a = openTab();
    const b = openTab();
    await wait(SETTLED_MS);

    const leader = a.leader.isLeader() ? a : b;
    const follower = a.leader.isLeader() ? b : a;
    leader.leader.publish(jobNote('job-1'));
    await wait(50);

    // Both, because the leader applies its own note through the same path it broadcasts — there is
    // no second reducer for a follower to fall behind.
    expect(leader.heard).toEqual([jobNote('job-1')]);
    expect(follower.heard).toEqual([jobNote('job-1')]);
  });
});

describe('the leader tab closing', () => {
  it('hands over with nothing announced, because the lock is the announcement', async () => {
    // A peer that already leads, so the tab under test starts as a follower rather than racing.
    const peer = openPeer('0000-leader');
    await peer.lead();
    const survivor = openTab();
    await wait(SETTLED_MS);
    expect(survivor.leader.isLeader()).toBe(false);
    survivor.leader.declare([SID], 3);
    const before = [...peer.received];

    peer.release();

    // Inside a handover deadline rather than an election window, and with nothing on the channel
    // in between: the old `resign` existed because a departure had to be *said* or waited out, and
    // the browser grants the lock to the next waiter with no message anywhere.
    await vi.waitFor(() => expect(survivor.leader.isLeader()).toBe(true), {
      timeout: HANDOVER_DEADLINE_MS,
      interval: 10,
    });
    // What the departing tab heard in the meantime is only what the new leader said *after* it had
    // the lock — a `hello` — never anything about the departure itself.
    const said = peer.received.slice(before.length) as { type: string }[];
    expect(said.map((message) => message.type)).not.toContain('resign');
  });

  it('leaves the notifications it already delivered behind it', async () => {
    const peer = openPeer('0000-leader');
    await peer.lead();
    const survivor = openTab();
    await wait(SETTLED_MS);

    peer.note(jobNote('job-before-close'));
    await wait(50);
    peer.release();
    await wait(SETTLED_MS);

    expect(survivor.heard).toEqual([jobNote('job-before-close')]);
    expect(survivor.leader.isLeader()).toBe(true);
  });
});

describe('the leader tab frozen or put in the back/forward cache', () => {
  // The one case the browser does *not* handle for us, and the reason the lease is narrowed rather
  // than simply deleted. A frozen tab has not gone away: it is alive, it still holds the lock, and
  // it is reading nothing — a leader nobody can depose. So the module releases on the lifecycle
  // events that mean it, and asks again on the ones that mean it came back.
  //
  // Both pairs are driven, because they are different events for different states and neither
  // implies the other: `pagehide` is unload and the bfcache, `freeze` is a tab the browser froze in
  // place and does *not* fire `pagehide` for. A one-pair implementation passes the first of these
  // and leaves a frozen tab holding the lock for the life of the browser session.
  for (const [hide, show] of [
    ['pagehide', 'pageshow'],
    ['freeze', 'resume'],
  ]) {
    it(`releases on ${hide}, so another tab can take the streams`, async () => {
      const leaving = openTab();
      const waiting = openTab();
      await wait(SETTLED_MS);
      expect(leaving.leader.isLeader()).toBe(true);
      expect(waiting.leader.isLeader()).toBe(false);

      dispatchEvent(new Event(hide as string));

      await vi.waitFor(() => expect(waiting.leader.isLeader()).toBe(true), {
        timeout: HANDOVER_DEADLINE_MS,
        interval: 10,
      });
      expect(leaving.leader.isLeader()).toBe(false);
    });

    it(`asks again on ${show}, or a restored tab could never lead again`, async () => {
      const restored = openTab();
      await wait(SETTLED_MS);
      expect(restored.leader.isLeader()).toBe(true);

      dispatchEvent(new Event(hide as string));
      await wait(50);
      expect(restored.leader.isLeader()).toBe(false);

      // Nobody took it while this tab was frozen, so coming back is coming back to the front of an
      // empty queue. Without the listener this asserts, releasing on the way in would be a
      // one-way door and strictly worse than the lease it replaces.
      dispatchEvent(new Event(show as string));

      await vi.waitFor(() => expect(restored.leader.isLeader()).toBe(true), {
        timeout: HANDOVER_DEADLINE_MS,
        interval: 10,
      });
    });
  }

  it('joins the back of the queue on the way back, rather than taking the streams twice', async () => {
    const frozen = openTab();
    const other = openTab();
    await wait(SETTLED_MS);
    expect(frozen.leader.isLeader()).toBe(true);

    dispatchEvent(new Event('pagehide'));
    await vi.waitFor(() => expect(other.leader.isLeader()).toBe(true), {
      timeout: HANDOVER_DEADLINE_MS,
      interval: 10,
    });
    dispatchEvent(new Event('pageshow'));
    await wait(SETTLED_MS);

    // Still exactly one, and it is the tab that took over — not the one that came back believing
    // it still led, which is precisely the two-leader case the old design could not prevent.
    expect([frozen.leader.isLeader(), other.leader.isLeader()].filter(Boolean)).toHaveLength(1);
    expect(other.leader.isLeader()).toBe(true);
  });
});

describe('the leader tab crashing, or being killed, with no beforeunload', () => {
  it('is taken over at once, because the browser gives the lock back', async () => {
    const peer = openPeer('0000-leader');
    await peer.lead();
    const survivor = openTab();
    await wait(SETTLED_MS);
    expect(survivor.leader.isLeader()).toBe(false);
    const before = peer.received.length;

    // A crash, an OOM kill, a force quit. `beforeunload` and `pagehide` are not guarantees, which
    // is why the old design needed a three-second lease *as well as* a `resign` — and why this is
    // the case that got dramatically better rather than merely smaller. The browser releases the
    // locks of a context that no longer exists, so from here it is indistinguishable from a polite
    // close and costs the same nothing.
    peer.release();

    await vi.waitFor(() => expect(survivor.leader.isLeader()).toBe(true), {
      timeout: HANDOVER_DEADLINE_MS,
      interval: 10,
    });
    // Driven against the previous implementation, this assertion needed an 8 s deadline and a
    // `WELL_INSIDE_LEASE_MS` step first, because a takeover landed between 3.0 s and 4.3 s after
    // the last heartbeat. Nothing was said on the channel then and nothing is said now — the
    // difference is entirely that nobody has to wait to find out.
    expect(peer.received.slice(before)).not.toContainEqual(
      expect.objectContaining({ type: 'resign' }),
    );

    // And the notifications flow to it once it leads.
    survivor.leader.publish(jobNote('job-after-takeover'));
    expect(survivor.heard).toEqual([jobNote('job-after-takeover')]);
  });

  it('is NOT taken over from a tab whose thread is wedged, which is the trade', async () => {
    // Stated as a test rather than as a paragraph, because it is the one thing the lease did that
    // a lock does not: a heartbeat is evidence a tab is *running*, a held lock is only evidence
    // its context still exists. A wedged main thread — an infinite loop, a pathological
    // synchronous parse — fires no lifecycle event and releases nothing.
    //
    // The trade was taken knowing this, because the lease's own false positives were commoner by a
    // long way: it could not tell a wedged leader from a merely throttled one either, and it
    // deposed both. The two cases below this one are what a throttled tab costs now, which is
    // nothing.
    const peer = openPeer('0000-leader');
    await peer.lead();
    const survivor = openTab();
    await wait(SETTLED_MS);
    expect(survivor.leader.isLeader()).toBe(false);

    peer.crashWithoutReleasing();
    await wait(1_500);

    expect(survivor.leader.isLeader()).toBe(false);
  });
});

describe('two tabs that both believe they lead', () => {
  it('cannot happen, which is an invariant this file used to have to maintain', async () => {
    // The old rule was "two leaders converge to one within a heartbeat", with a whole id-ordered
    // yield rule to make the convergence deterministic, because a suspended tab waking up produced
    // a second leader by itself. Exclusivity is the browser's now and holds across every tab of the
    // origin, so what used to be a convergence property is a plain impossibility.
    const peer = openPeer('0000-leader');
    await peer.lead();
    const a = openTab();
    const b = openTab();

    // Sampled over several announce ticks rather than read once: the failure this replaces was a
    // *transient* second leader, so a single reading at a quiet moment is exactly what would miss
    // it.
    for (let tick = 0; tick < 4; tick += 1) {
      await wait(300);
      expect([a.leader.isLeader(), b.leader.isLeader()].filter(Boolean)).toHaveLength(0);
    }
  }, 15_000);

  it('does not stand down for a stray message from another tab', async () => {
    // The `heartbeat` handler used to depose this tab on a message alone, which is how a woken tab
    // took leadership back from whoever had it. Nothing on the channel may do that now — the lock
    // is the only thing that decides — and a `hello` is the message a joining tab sends, so this
    // is the shape most likely to be wired back into a stand-down by accident.
    const survivor = openTab();
    await wait(SETTLED_MS);
    expect(survivor.leader.isLeader()).toBe(true);

    openPeer('!smaller-than-any-uuid').hello();
    await wait(100);

    expect(survivor.leader.isLeader()).toBe(true);
  });
});

describe('a browser that cannot coordinate', () => {
  // One branch in the module, so one case here per way of reaching it — and the third, both
  // missing at once, because "either" and "both" are different conditions and a `&&` written where
  // a `||` belongs passes the first two.
  for (const [what, missing] of [
    ['no BroadcastChannel', ['BroadcastChannel']],
    ['no navigator.locks', ['locks']],
    ['neither', ['BroadcastChannel', 'locks']],
  ] as [string, string[]][]) {
    it(`lets every tab lead with ${what}, which is what this app did before there was an election`, async () => {
      if (missing.includes('BroadcastChannel')) vi.stubGlobal('BroadcastChannel', undefined);
      if (missing.includes('locks')) {
        Object.defineProperty(navigator, 'locks', { value: null, configurable: true });
      }
      try {
        const a = openTab();
        const b = openTab();

        // Immediately, with nothing to wait for. The alternative — treating "cannot coordinate" as
        // "must not watch" — would turn a missing browser API into silence about a job a chemist
        // is waiting on.
        expect(a.leader.isLeader()).toBe(true);
        expect(b.leader.isLeader()).toBe(true);

        // And a note still reaches its own tab, so the leader's own store is still updated.
        a.leader.publish(jobNote('job-alone'));
        expect(a.heard).toEqual([jobNote('job-alone')]);
        expect(b.heard).toEqual([]);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  }
});

/* ── the wiring, not the election ─────────────────────────────────────────── */

const auth: AuthProvider = {
  mode: 'dev',
  account: null,
  getAccessToken: async () => null,
  login: async () => undefined,
  logout: async () => undefined,
  handleUnauthorized: async () => false,
};

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth, ready: true, revision: 0, refresh: () => {} }),
}));

let connects = 0;
/**
 * The sessions this realm is holding a stream for **right now**, in the order they were opened.
 *
 * Not a log of connects: the set moves for reasons that are not this tab's — another window opening
 * a conversation re-merges the account's watch set — so a cumulative list answers "what did it ever
 * try" where the question is "what does the account hold", which is the one the pod's cap is about.
 * Aborts are read off the signal the hook really passes, so a stream that was dropped leaves.
 */
let live: string[] = [];
let restoreFetch: (() => void) | null = null;

beforeEach(() => {
  connects = 0;
  live = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    connects += 1;
    const sessionId = String(input).replace(/^.*\/sessions\/([^/]+)\/events.*$/, '$1');
    live.push(sessionId);
    init?.signal?.addEventListener('abort', () => {
      const at = live.indexOf(sessionId);
      if (at !== -1) live.splice(at, 1);
    });
    // A stream that opens and stays silent, which is what a healthy one does between completions.
    return Promise.resolve(new Response(new ReadableStream(), { status: 200 }));
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
  };
  useChatStore.setState({
    conversations: {
      c1: {
        id: 'c1',
        sessionId: SID,
        title: 'x',
        messages: [{ id: 'm1', role: 'user', text: 'hi' }],
        updatedAt: 1,
      } as never,
    },
    activeId: 'c1',
    jobStreamsThrottled: false,
    jobStreamsFailing: [],
    jobFeed: [],
  });
});

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

describe('a tab that did not get the lock', () => {
  it('opens no stream at all, which is the whole point of the cap arithmetic', async () => {
    const peer = openPeer('0000-leader');
    await peer.lead();

    const { unmount } = renderHook(() => useJobStreams());
    try {
      await wait(SETTLED_MS);
      // Not "fewer streams" — none. `service_max_event_streams_per_user` is 5 and a leader spends
      // 3; a follower spending even one would put two windows back over the cap on the third tab.
      expect(connects).toBe(0);
    } finally {
      unmount();
    }
  });

  it('still gets the notification the leader saw', async () => {
    const peer = openPeer('0000-leader');
    await peer.lead();

    const { unmount } = renderHook(() => useJobStreams());
    try {
      await wait(SETTLED_MS);
      peer.note(jobNote('job-relayed'));
      await wait(50);

      // The store, not a recorder: this is the assertion that the relay reaches the thing a
      // chemist actually looks at.
      expect(useChatStore.getState().jobFeed.map((item) => item.event.job_id)).toEqual([
        'job-relayed',
      ]);
      expect(connects).toBe(0);
    } finally {
      unmount();
    }
  });

  it('opens the streams itself once the leader releases', async () => {
    const peer = openPeer('0000-leader');
    await peer.lead();

    const { unmount } = renderHook(() => useJobStreams());
    try {
      await wait(SETTLED_MS);
      expect(connects).toBe(0);

      peer.release();
      await wait(SETTLED_MS);

      // One per watched session. Without this the whole feature is "the last tab to open watches
      // nothing", which is worse than the behaviour it replaced.
      expect(connects).toBe(1);
    } finally {
      unmount();
    }
  });
});

/* ── what the leader watches, which is not the same as what it wants ───────── */

/**
 * Two tabs on one account do not watch the same conversations.
 *
 * `watchedSessionKey` reads this tab's own `conversations` and its own `activeId`, and neither is
 * shared: the store is hydrated per tab and `activeId` is by definition per window. So "one tab
 * holds the streams" is only half a design — the half that elects. The other half is that the
 * leader must hold the streams the *other* tabs wanted, or the feature loses exactly the
 * notifications it was built to stop losing, and loses them silently, for the conversation the
 * other chemist's window is actually looking at.
 *
 * Measured against the election before the interest protocol existed: the account held one stream,
 * for the leader's own `SID`, and the follower's conversation was watched by nobody.
 */
const SID2 = 'b'.repeat(32);
const SID3 = 'c'.repeat(32);
const SID4 = 'd'.repeat(32);
const SID5 = 'e'.repeat(32);
const SID6 = 'f'.repeat(32);

function seedConversations(ids: readonly string[]): void {
  const conversations: Record<string, unknown> = {};
  ids.forEach((sessionId, index) => {
    conversations[`c${index}`] = {
      id: `c${index}`,
      sessionId,
      title: 'x',
      messages: [{ id: `m${index}`, role: 'user', text: 'hi' }],
      updatedAt: ids.length - index,
    };
  });
  useChatStore.setState({
    conversations: conversations as never,
    activeId: 'c0',
    jobStreamsThrottled: false,
    jobStreamsFailing: [],
    jobFeed: [],
  });
}

/** Wait for the account's held set to settle on exactly these sessions, in any order. */
async function holds(sessions: readonly string[]): Promise<void> {
  await vi.waitFor(() => expect([...live].sort()).toEqual([...sessions].sort()), {
    timeout: DEADLINE_MS,
    interval: 50,
  });
}

describe('merging what every tab asked for', () => {
  it('takes each tab’s first choice before any tab’s second', () => {
    // Three tabs, each wanting three, against a budget of three. Concatenation would answer
    // ['a1','a2','a3'] and leave two windows watching nothing at all.
    expect(
      mergeWatchSets(
        ['a1', 'a2', 'a3'],
        [
          ['b1', 'b2'],
          ['c1', 'c2'],
        ],
        3,
      ),
    ).toEqual(['a1', 'b1', 'c1']);
  });

  it('fills the budget from whoever is left once a tab runs out of conversations', () => {
    expect(mergeWatchSets(['a1', 'a2', 'a3'], [['b1']], 3)).toEqual(['a1', 'b1', 'a2']);
  });

  it('counts a conversation two tabs both want once', () => {
    // Two windows on the same conversation is the ordinary case, not the exotic one, and it must
    // cost one stream rather than two — the budget is the account's.
    expect(mergeWatchSets(['a1', 'a2'], [['a1', 'b2']], 3)).toEqual(['a1', 'a2', 'b2']);
  });

  it('never exceeds the budget, whatever it is handed', () => {
    expect(mergeWatchSets(['a1', 'a2', 'a3'], [['b1', 'b2', 'b3']], 1)).toEqual(['a1']);
    expect(mergeWatchSets(['a1'], [['b1']], 0)).toEqual([]);
  });

  it('gives every tab its first choice eventually when there are more tabs than budget', () => {
    // Rank 0 alone answers a *six*-tab account with three sessions and the same three every time,
    // because the peer order is a sort on a stable random id. So the three windows past the
    // budget were watched by nobody in the account, for the life of the page — the outcome the
    // module docstring names as the one unacceptable one. Over one full cycle of `turn`, every
    // window's first choice is held.
    const heads = ['a1', 'b1', 'c1', 'd1', 'e1', 'f1'];
    const seen = new Set<string>();
    for (let turn = 0; turn < heads.length; turn += 1) {
      const merged = mergeWatchSets(
        ['a1', 'a2'],
        [['b1'], ['c1'], ['d1'], ['e1'], ['f1']],
        3,
        turn,
      );
      // Still the account's budget, at every step of the rotation.
      expect(merged).toHaveLength(3);
      for (const sessionId of merged) seen.add(sessionId);
    }
    expect([...seen].sort()).toEqual([...heads].sort());
  });

  it('does not rotate a set that is not starved, or it would churn connects for nothing', () => {
    // Two windows at a budget of three: everybody's first choice already fits, so there is no
    // window to rescue and a rotation would only move `a2` out and `b2` in — one disconnect and
    // one connect per step, spent against the very cap this file exists to respect.
    for (let turn = 0; turn < 5; turn += 1) {
      expect(mergeWatchSets(['a1', 'a2', 'a3'], [['b1', 'b2']], 3, turn)).toEqual([
        'a1',
        'b1',
        'a2',
      ]);
    }
  });

  it('does not let a tab that asked for nothing make the set look starved', () => {
    // An empty list is a window with no conversation yet — every tab declares one before its
    // session exists — or one that said so on its way out. It contributes at no rank, so the two
    // real tabs here fit inside the budget and nothing should rotate. Counted, they make
    // `lists.length` four against a budget of three, and the set churns: `a2` out and `b2` in at
    // turn 1, which is a disconnect and a connect to rescue a window that was never dark.
    for (let turn = 0; turn < 4; turn += 1) {
      expect(mergeWatchSets(['a1', 'a2', 'a3'], [['b1', 'b2'], [], []], 3, turn)).toEqual([
        'a1',
        'b1',
        'a2',
      ]);
    }
  });
});

describe('more interested tabs than the account may hold streams for', () => {
  it('rotates over them, so no window is watched by nobody for the life of the page', async () => {
    // Driven on real memberships over a real channel, because the defect this covers is not in
    // `mergeWatchSets`'s arithmetic — it is whether the leader ever *advances* the rotation. A
    // unit test of the function alone passes with `rebuild` calling it at a fixed turn for ever,
    // which is exactly what shipped.
    //
    // Fake timers so six rotations cost milliseconds rather than six minutes; `Date.now` moves
    // with them, which is what the rotation step is derived from.
    vi.useFakeTimers();
    try {
      const leader = openTab();
      leader.leader.declare([SID], 3);
      // Five other windows, each looking at a different conversation, each saying so once a second
      // exactly as a live follower does.
      [SID2, SID3, SID4, SID5, SID6].forEach((sessionId, index) => {
        openPeer(`peer-${index}`).keepDeclaring([sessionId]);
      });
      await vi.advanceTimersByTimeAsync(SETTLED_MS);
      expect(leader.leader.isLeader()).toBe(true);

      const seen = new Set<string>();
      for (let step = 0; step < 6; step += 1) {
        await vi.advanceTimersByTimeAsync(ROTATION_MS);
        const watched = leader.leader.watched();
        // Never over the account's budget, at any point in the cycle: the rotation is a fairer
        // three, not a fourth stream.
        expect(watched).toHaveLength(3);
        for (const sessionId of watched) seen.add(sessionId);
      }

      // Driven before the rotation existed, the same three came back at every sample and this set
      // had three members: the other three windows' conversations were watched by nothing in the
      // account and never would be.
      expect([...seen].sort()).toEqual([SID, SID2, SID3, SID4, SID5, SID6].sort());
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);
});

describe('two tabs watching different conversations', () => {
  it('watches what the follower asked for, not only what the leader wanted', async () => {
    const follower = openPeer('zzzz-follower');
    follower.keepDeclaring([SID2]);

    const { unmount } = renderHook(() => useJobStreams());
    try {
      // Both, in one account, from one tab. The follower opens nothing and is still watched.
      await holds([SID, SID2]);
    } finally {
      unmount();
    }
  });

  it('gives every tab its first choice when the union is over the budget', async () => {
    seedConversations([SID, SID2, SID3]);
    const follower = openPeer('zzzz-follower');
    // The follower's own top three, none of which the leader wanted.
    follower.keepDeclaring([SID4, SID5, SID6]);

    const { unmount } = renderHook(() => useJobStreams());
    try {
      // Three, not six: the budget is the account's, which is the whole arithmetic this feature
      // exists for. And the two heads are in it — the leader's `SID` and the follower's `SID4` —
      // so neither window is left watching nothing.
      await holds([SID, SID4, SID2]);
    } finally {
      unmount();
    }
  });

  it('reclaims the slot when the tab that asked for it stops saying so — but not before', async () => {
    // Both halves of `INTEREST_LEASE_MS`, because either one alone is satisfied by a wrong number.
    // A lease that is too short passes the reclaim and loses a live hidden window's notifications;
    // no lease at all passes the first assertion and holds a dead tab's stream for ever.
    //
    // On a clock: the lease is five minutes, which is not a wait a real-timer test can afford.
    vi.useFakeTimers();
    try {
      seedConversations([SID, SID2, SID3]);
      const follower = openPeer('zzzz-follower');
      follower.keepDeclaring([SID4]);

      const { unmount } = renderHook(() => useJobStreams());
      try {
        await vi.advanceTimersByTimeAsync(SETTLED_MS);
        expect([...live].sort()).toEqual([SID, SID4, SID2].sort());

        // The follower crashes — no resignation, nothing announced, which is the only shape a
        // crash has from here, and the same shape a tab the browser froze has.
        follower.goSilent();

        // Well inside the lease, its slot is still its own. This is the half the leadership lease
        // got wrong: three seconds is shorter than the interval a browser clamps a hidden tab's
        // timers to, so the window whose notifications matter most lost its slot every cycle.
        await vi.advanceTimersByTimeAsync(INTEREST_LEASE_MS / 2);
        expect([...live].sort()).toEqual([SID, SID4, SID2].sort());

        // Past it, the slot goes to somebody who is still here. Without any expiry the leader
        // would hold one of three streams for a window nobody is looking at.
        await vi.advanceTimersByTimeAsync(INTEREST_LEASE_MS);
        expect([...live].sort()).toEqual([SID, SID2, SID3].sort());
      } finally {
        unmount();
      }
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it('keeps a backgrounded window’s slot while the browser clamps its timers to once a minute', async () => {
    // The case the interest lease exists for, driven at the rate Chrome's intensive throttling
    // imposes on a tab hidden for about five minutes. The tab is *alive* — a chemist has it open
    // in another window and a conformer search running in it — and the only thing wrong with it is
    // that its announcements arrive a minute apart.
    //
    // Measured against the three-second lease this replaced, sampling every 500 ms over three
    // minutes: 342 of 360 samples had this window's conversation watched by nobody, and each
    // recovery opened a fresh stream.
    vi.useFakeTimers();
    try {
      const leader = openTab();
      leader.leader.declare([SID], 3);
      openPeer('zzzz-hidden').keepDeclaring([SID2], 60_000);
      await vi.advanceTimersByTimeAsync(SETTLED_MS);
      expect(leader.leader.isLeader()).toBe(true);

      let dark = 0;
      for (let elapsed = 0; elapsed < 3 * 60_000; elapsed += 5_000) {
        await vi.advanceTimersByTimeAsync(5_000);
        if (!leader.leader.watched().includes(SID2)) dark += 1;
      }
      expect(dark).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it('hands a follower’s slot back the moment its window goes away', async () => {
    // What makes a five-minute expiry affordable. A follower has no leadership to resign, so
    // before this it simply stopped announcing and the leader held its stream for the rest of the
    // lease — five minutes of one of three slots spent on a window that is gone.
    //
    // The message is an `interest` carrying nothing rather than a new kind: `resign` means "the
    // streams are unheld" and starts an election in every tab, which a follower leaving must not.
    const leaderPeer = openPeer('0000-leader');
    await leaderPeer.lead();
    const leaving = openTab();
    await wait(SETTLED_MS);
    expect(leaving.leader.isLeader()).toBe(false);
    leaving.leader.declare([SID2], 3);
    await wait(50);
    expect(leaderPeer.received).toContainEqual({
      type: 'interest',
      from: leaving.leader.id,
      sessions: [SID2],
    });
    leaderPeer.received.length = 0;

    dispatchEvent(new Event('pagehide'));
    await wait(50);

    expect(leaderPeer.received).toContainEqual({
      type: 'interest',
      from: leaving.leader.id,
      sessions: [],
    });
    // And it did not take the streams with it: a follower leaving frees its slot, and nothing
    // else. The old shape of this mistake was sending `resign`, which meant "the streams are
    // unheld" and started an election in every tab; there is no message that can do that now, and
    // the assertion that matters is that the peer still holds the lock.
    expect(leaderPeer.received).not.toContainEqual(expect.objectContaining({ type: 'resign' }));
  });

  it('says the same thing when the membership is torn down rather than navigated away from', async () => {
    // `close()` is the path a React unmount takes and `pagehide` is the path a browser takes; they
    // are two branches with one argument, and a test of either alone leaves the other deletable.
    const leaderPeer = openPeer('0000-leader');
    await leaderPeer.lead();
    const leaving = openTab();
    await wait(SETTLED_MS);
    expect(leaving.leader.isLeader()).toBe(false);
    leaving.leader.declare([SID2], 3);
    await wait(50);
    leaderPeer.received.length = 0;

    leaving.leader.close();
    await wait(50);

    expect(leaderPeer.received).toContainEqual({
      type: 'interest',
      from: leaving.leader.id,
      sessions: [],
    });
  });

  it('acts on an interest that says nothing, rather than keeping what that tab last wanted', async () => {
    // The leader's half of the same message, and the half that makes the departure cheap: a tab's
    // newest interest replaces its previous one, so a `[]` frees the slot now instead of at the
    // end of a five-minute lease. Ignoring an empty interest as "nothing to record" reads as
    // harmless and is exactly what leaves the stream open.
    const leader = openTab();
    leader.leader.declare([SID], 3);
    const peer = openPeer('zzzz-follower');
    peer.keepDeclaring([SID2]);
    await wait(SETTLED_MS);
    expect(leader.leader.watched()).toContain(SID2);

    peer.goSilent();
    new BroadcastChannel(CHANNEL).postMessage({
      type: 'interest',
      from: 'zzzz-follower',
      sessions: [],
    });
    await wait(ANNOUNCE_TICK_MS);

    expect(leader.leader.watched()).not.toContain(SID2);
  });

  it('watches the follower’s conversation even while the leader is backgrounded', async () => {
    // `backgrounded` trims what *this window* asks for, down to one. It must not trim what the
    // account holds, or a chemist's visible window would be cut to a single stream by a tab they
    // are not even looking at — which is the old per-tab budget coming back wearing the election's
    // clothes.
    //
    // Fake timers before anything is created, so the election's campaign, the watchdog, the peer's
    // announcements and `HIDDEN_GRACE_MS` (30 s) are all on the clock being advanced. Advancing is
    // the only way to reach the grace period at all; a real-clock version of this case would be a
    // thirty-second test.
    vi.useFakeTimers();
    try {
      seedConversations([SID, SID2, SID3]);
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      const follower = openPeer('zzzz-follower');
      follower.keepDeclaring([SID4, SID5]);

      const { unmount } = renderHook(() => useJobStreams());
      try {
        await vi.advanceTimersByTimeAsync(60_000);

        // One of the leader's own — it is hidden and asks for one — and both of the follower's.
        // Three streams, not one, and not four.
        expect([...live].sort()).toEqual([SID, SID4, SID5].sort());
      } finally {
        unmount();
      }
    } finally {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      vi.useRealTimers();
    }
  }, 15_000);

  it('holds one stream for the whole account once a 429 says it is over the cap', async () => {
    // The backstop the election does not replace. `jobStreamsThrottled` is evidence about the
    // *account* rather than about this window, so it has to cut the merged set and not merely this
    // tab's share — otherwise the leader would answer a 429 by dropping its own conversation and
    // keeping three streams open for everybody else's.
    //
    // **One stream is not the same as one window**, which is what the rotation changes here and
    // why this case is on a clock now. A budget of one and two interested windows is the starved
    // case at its sharpest: whichever window the leader happened to be, the other one used to be
    // watched by nobody for the life of the page. The cap is still honoured — one stream, never
    // two, at every point below — and the window it belongs to is what moves.
    vi.useFakeTimers();
    try {
      seedConversations([SID, SID2, SID3]);
      useChatStore.setState({ jobStreamsThrottled: true });
      const follower = openPeer('zzzz-follower');
      follower.keepDeclaring([SID4, SID5]);

      const { unmount } = renderHook(() => useJobStreams());
      try {
        await vi.advanceTimersByTimeAsync(SETTLED_MS);
        // One, and one of the two windows' — which one is a function of the clock, because the
        // rotation step is derived from it rather than from a counter this tab owns. Asserting
        // which would be asserting the phase the test happened to start in.
        expect(live).toHaveLength(1);

        const held = new Set<string>();
        for (let step = 0; step < 3; step += 1) {
          await vi.advanceTimersByTimeAsync(ROTATION_MS);
          // The assertion the 429 path is about, and it is checked at every step rather than at
          // the end: a rotation that opened the next stream before dropping the last would be two
          // against a cap this account has already been told it is over.
          expect(live).toHaveLength(1);
          held.add(live[0] as string);
        }
        expect([...held].sort()).toEqual([SID, SID4].sort());
      } finally {
        unmount();
      }
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);
});

/* ── the warning, which a follower cannot see for itself ───────────────────── */

describe('the stream health a follower holds no streams to observe', () => {
  it('is relayed, so a chemist is not shown a working app while notifications are failing', async () => {
    const leader = openPeer('0000-leader');
    await leader.lead();

    const { unmount } = renderHook(() => useJobStreams());
    try {
      await wait(SETTLED_MS);
      expect(useChatStore.getState().jobStreamsFailing).toEqual([]);

      leader.note({ kind: 'health', failing: [SID], throttled: true });
      await vi.waitFor(() => expect(useChatStore.getState().jobStreamsFailing).toEqual([SID]));
      // The throttle travels as a *report* — it is what a follower's indicator is drawn from, and
      // a follower holds no streams to learn it any other way.
      expect(useChatStore.getState().jobStreamsThrottledElsewhere).toBe(true);
      // And it is not adopted as this tab's own. `jobStreamsThrottled` is evidence that *this* tab
      // 429'd twice and it never clears; writing it from a relay made one window's two 429s pin
      // every page on the account to a single stream for ever.
      expect(useChatStore.getState().jobStreamsThrottled).toBe(false);

      // It follows the reporter, in both directions, which is the whole difference between a
      // report and a decision.
      leader.note({ kind: 'health', failing: [], throttled: false });
      await vi.waitFor(() => expect(useChatStore.getState().jobStreamsFailing).toEqual([]));
      expect(useChatStore.getState().jobStreamsThrottledElsewhere).toBe(false);
    } finally {
      unmount();
    }
  });

  it('is replayed to a tab that opens after the failures started', async () => {
    // The `hello` branch's `if (health) send(...)`, which nothing asserted: the existing relay case
    // publishes *after* the follower has joined, so it drives the ordinary broadcast and never the
    // replay. Deleted, the whole 1,120-test suite stayed green — and the consequence is a chemist
    // opening a second window into a failing account and being shown an app that looks fine, which
    // is the exact hazard the health note exists for, one tab over.
    //
    // This used to hang off `claim`. That message carried two unrelated jobs — start a campaign,
    // and ask everyone else to restate themselves — and only the second one survived the move to a
    // Web Lock, under the name it now has.
    const leader = openTab();
    await wait(SETTLED_MS);
    expect(leader.leader.isLeader()).toBe(true);
    leader.leader.publish({ kind: 'health', failing: [SID], throttled: true });

    // A window opened now, after the streams have already started failing. Its first act is a
    // `hello`, and the answer to a `hello` is where the account's state has to reach it.
    const joining = openPeer('zzzz-joining');
    joining.hello();
    await wait(100);

    expect(joining.received).toContainEqual({
      type: 'note',
      from: leader.leader.id,
      note: { kind: 'health', failing: [SID], throttled: true },
    });
  });

  it('does not outlive the leader that reported it', async () => {
    // A failure warning describes streams the departed tab was holding. The ones this tab is about
    // to open have not failed at anything — so a takeover that kept the warning would pin a red
    // indicator on a healthy account until somebody reloaded the page, and the chemist would be
    // told notifications were broken while they were arriving.
    const leader = openPeer('0000-leader');
    await leader.lead();

    const { unmount } = renderHook(() => useJobStreams());
    try {
      await wait(SETTLED_MS);
      leader.note({ kind: 'health', failing: [SID], throttled: false });
      await vi.waitFor(() => expect(useChatStore.getState().jobStreamsFailing).toEqual([SID]));

      leader.received.length = 0;
      leader.release();

      await vi.waitFor(() => expect(useChatStore.getState().jobStreamsFailing).toEqual([]), {
        timeout: DEADLINE_MS,
        interval: 50,
      });
      // And it says so, rather than clearing it privately: a third tab is carrying the same stale
      // warning and has no other way to hear that it is over.
      //
      // Polled rather than read once, because the two facts above it are not the same fact: the
      // store is cleared *synchronously* inside `sync`, and the broadcast that follows it reaches
      // another channel in a later task. Reading `received` the instant the store settled asserted
      // on a postMessage that had not been dispatched yet — measured at `8ccdef2`, before any of
      // this wave's changes, as 2 failures in 3 runs, with `received` holding only the survivor's
      // own `hello`.
      await vi.waitFor(() =>
        expect(leader.received).toContainEqual({
          type: 'note',
          from: expect.any(String),
          note: { kind: 'health', failing: [], throttled: false },
        }),
      );
    } finally {
      unmount();
    }
  }, 15_000);
});

describe('the throttle one tab’s 429s taught it', () => {
  it('does not follow a takeover into the next leader’s budget', async () => {
    // The blast radius, driven end to end. A follower is told the account is over the cap, the
    // leader then goes away, and this tab takes over: it must open the account's whole budget and
    // find out for itself, not start life pinned to one stream by somebody else's two 429s.
    //
    // `jobStreamsThrottled` is irreversible by design — a tab that over-subscribed once will do it
    // again — which is precisely why it may not be handed to a tab that has not. The backstop is
    // unchanged and is where the recovery lives: if this leader really is over the cap, two 429s
    // tell it so, and the 429 test above pins that path.
    seedConversations([SID, SID2, SID3]);
    const leader = openPeer('0000-leader');
    await leader.lead();

    const { unmount } = renderHook(() => useJobStreams());
    try {
      await wait(SETTLED_MS);
      expect(connects).toBe(0);

      leader.note({ kind: 'health', failing: [], throttled: true });
      await vi.waitFor(() =>
        expect(useChatStore.getState().jobStreamsThrottledElsewhere).toBe(true),
      );

      leader.release();

      // Three, which is the account's budget. Relayed into `jobStreamsThrottled` this was one —
      // for the life of this page, with nothing able to clear it.
      await holds([SID, SID2, SID3]);
    } finally {
      unmount();
    }
  }, 15_000);
});

/* ── the path a completion actually takes to the other window ──────────────── */

describe('a job finishing on the leader’s stream', () => {
  it('is broadcast, not merely applied here, or the other window never hears it', async () => {
    // The wiring the whole feature rests on, and the one place where "the store changed" is not
    // enough: the leader holds the account's only stream, so a completion that stopped at its own
    // `pushJobFinished` would reach one window and be lost to every other — which is what the old
    // behaviour did per tab, and is the loss the election is supposed to have removed.
    const watcher = openPeer('￿-watching-only');
    const frame = {
      type: 'job_completed',
      job_id: 'job-broadcast',
      summary: {},
    };
    globalThis.fetch = (() => {
      connects += 1;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`,
                ),
              );
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    }) as typeof fetch;

    const { unmount } = renderHook(() => useJobStreams());
    try {
      await vi.waitFor(
        () =>
          expect(watcher.received).toContainEqual({
            type: 'note',
            from: expect.any(String),
            note: { kind: 'job', event: frame, sessionId: SID },
          }),
        { timeout: DEADLINE_MS, interval: 50 },
      );
      // And it landed here too, through the same one path rather than a second reducer.
      expect(useChatStore.getState().jobFeed.map((item) => item.event.job_id)).toEqual([
        'job-broadcast',
      ]);
    } finally {
      unmount();
    }
  }, 15_000);
});
