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
 *  - **A scripted peer.** A plain channel the test speaks the protocol on. Some of these cases are
 *    about a tab that has stopped running — frozen, crashed, suspended and woken — and a second
 *    real membership cannot be made to stop running inside one event loop. What a scripted peer
 *    produces is exactly what the surviving tab *sees*, which is the only thing the surviving
 *    tab's behaviour can depend on.
 *
 * The last two cases leave the module and drive `useJobStreams` itself, because "a follower opens
 * no stream" and "a follower is still told" are properties of the wiring rather than of the
 * election.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  CHANNEL,
  ROTATION_MS,
  createStreamLeader,
  mergeWatchSets,
  type Note,
  type StreamLeader,
} from '../src/state/jobStreamLeader.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import { useJobStreams } from '../src/hooks/useJobStreams.ts';
import type { AuthProvider } from '../src/auth/types.ts';

/** Longer than the module's own `ELECTION_MS` (250 ms), shorter than its `LEASE_MS` (3 s). */
const AFTER_ELECTION_MS = 400;
/**
 * Well inside `LEASE_MS`, so "has not taken over yet" can be asserted rather than assumed.
 *
 * Waiting a *fixed* time past the lease is the thing to avoid: the watchdog checks once per
 * `HEARTBEAT_MS`, so a takeover lands anywhere between 3.0 s and 4.3 s after the last heartbeat,
 * and a wait chosen at the low end of that fails for a reason that looks like a bug. The takeovers
 * below are polled with a deadline instead.
 */
const WELL_INSIDE_LEASE_MS = 1_000;
/** Generous upper bound: the lease, plus the watchdog's own period, plus an election, plus room. */
const TAKEOVER_DEADLINE_MS = 8_000;

const SID = 'a'.repeat(32);

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
 * `heartbeat` is sent on an interval because that is what a live leader does; stopping the interval
 * without a `resign` is, from the surviving tab's side, indistinguishable from a crash, a freeze or
 * an OS kill — which is precisely why the lease exists.
 */
function openPeer(id: string): {
  id: string;
  beat: () => void;
  keepAlive: () => void;
  goSilent: () => void;
  resign: () => void;
  claim: () => void;
  keepDeclaring: (sessions: string[]) => void;
  note: (note: Note) => void;
  received: unknown[];
} {
  const channel = new BroadcastChannel(CHANNEL);
  const received: unknown[] = [];
  channel.addEventListener('message', (event) => received.push((event as MessageEvent).data));
  let timer: ReturnType<typeof setInterval> | null = null;
  const beat = (): void => channel.postMessage({ type: 'heartbeat', from: id });
  const goSilent = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  // Registered with its timer, so teardown stops the heartbeat BEFORE it closes the channel. A
  // surviving interval posting into a closed channel throws out of the timer callback, where
  // nothing can catch it, and vitest reports it against whichever test happened to be running.
  peers.push({ channel, stop: goSilent });
  return {
    id,
    beat,
    keepAlive: () => {
      beat();
      timer ??= setInterval(beat, 200);
    },
    goSilent,
    resign: () => channel.postMessage({ type: 'resign', from: id }),
    claim: () => channel.postMessage({ type: 'claim', from: id }),
    // A live follower, which repeats what it wants watched rather than saying it once. Saying it
    // once is what a *dead* follower looks like, and the module treats the two differently on
    // purpose — so a harness that announced once could not tell them apart either.
    keepDeclaring: (sessions) => {
      const say = (): void => channel.postMessage({ type: 'interest', from: id, sessions });
      say();
      timer ??= setInterval(say, 200);
    },
    note: (note) => channel.postMessage({ type: 'note', from: id, note }),
    received,
  };
}

afterEach(() => {
  for (const tab of tabs) tab.close();
  tabs = [];
  for (const peer of peers) {
    peer.stop();
    peer.channel.close();
  }
  peers = [];
});

describe('two tabs opening at the same moment', () => {
  it('agree on exactly one leader, and it is the same one on both sides', async () => {
    const a = openTab();
    const b = openTab();

    await wait(AFTER_ELECTION_MS);

    expect([a.leader.isLeader(), b.leader.isLeader()].filter(Boolean)).toHaveLength(1);
    // Not merely "one of them": the smaller id, so the outcome is a property of the pair rather
    // than of which campaign timer happened to fire first.
    const expected = a.leader.id < b.leader.id ? a : b;
    expect(expected.leader.isLeader()).toBe(true);
  });

  it('loses nothing: what the leader publishes reaches the other tab', async () => {
    const a = openTab();
    const b = openTab();
    await wait(AFTER_ELECTION_MS);

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
  it('hands over on the resignation rather than on the lease', async () => {
    // A peer that already leads, so the tab under test starts as a follower rather than racing.
    const peer = openPeer('0000-leader');
    peer.keepAlive();
    const survivor = openTab();
    await wait(AFTER_ELECTION_MS);
    expect(survivor.leader.isLeader()).toBe(false);

    peer.goSilent();
    peer.resign();
    // One election window, not one lease. The difference is the point of sending `resign` at all:
    // 3 s of nobody holding a stream, every time somebody closes a tab, would be the cost.
    await wait(AFTER_ELECTION_MS);

    expect(survivor.leader.isLeader()).toBe(true);
  });

  it('leaves the notifications it already delivered behind it', async () => {
    const peer = openPeer('0000-leader');
    peer.keepAlive();
    const survivor = openTab();
    await wait(AFTER_ELECTION_MS);

    peer.note(jobNote('job-before-close'));
    await wait(50);
    peer.goSilent();
    peer.resign();
    await wait(AFTER_ELECTION_MS);

    expect(survivor.heard).toEqual([jobNote('job-before-close')]);
    expect(survivor.leader.isLeader()).toBe(true);
  });
});

describe('the leader tab going away', () => {
  it('announces it on pagehide, which is what makes the handover fast', async () => {
    // The listener, not the message: `close()` sends a resignation because a test calls it, and a
    // browser never calls it. What a real tab gets is `pagehide` — chosen over `beforeunload`
    // because it also fires on a mobile app switch and on the way into the back/forward cache,
    // where `beforeunload` is documented not to. Without this listener every close costs a full
    // lease of nobody holding a stream.
    const watcher = openPeer('\uffff-watching-only');
    const leaving = openTab();
    await wait(AFTER_ELECTION_MS);
    expect(leaving.leader.isLeader()).toBe(true);
    watcher.received.length = 0;

    dispatchEvent(new Event('pagehide'));
    await wait(50);

    expect(watcher.received).toContainEqual({ type: 'resign', from: leaving.leader.id });
  });
});

describe('the leader tab crashing with no beforeunload', () => {
  it('is taken over on the lease, because nothing announced anything', async () => {
    const peer = openPeer('0000-leader');
    peer.keepAlive();
    const survivor = openTab();
    await wait(AFTER_ELECTION_MS);
    expect(survivor.leader.isLeader()).toBe(false);

    // No `resign`. This is the whole case: `beforeunload` and `pagehide` are not guarantees, and a
    // design that depended on one would lose every notification after a crash, an OOM kill or a
    // force quit.
    peer.goSilent();

    // Not instantly — a single missed heartbeat must not start an election, or a busy leader would
    // be deposed by its own main thread.
    await wait(WELL_INSIDE_LEASE_MS);
    expect(survivor.leader.isLeader()).toBe(false);

    await vi.waitFor(() => expect(survivor.leader.isLeader()).toBe(true), {
      timeout: TAKEOVER_DEADLINE_MS,
      interval: 100,
    });
  }, 15_000);

  it('is the same path a suspended tab takes, because a frozen tab is a silent tab', async () => {
    const peer = openPeer('0000-leader');
    peer.keepAlive();
    const survivor = openTab();
    await wait(AFTER_ELECTION_MS);

    // A backgrounded tab whose timers the browser froze. Indistinguishable from the crash above
    // from this side, deliberately: the survivor must not need to know which it was.
    peer.goSilent();
    await vi.waitFor(() => expect(survivor.leader.isLeader()).toBe(true), {
      timeout: TAKEOVER_DEADLINE_MS,
      interval: 100,
    });

    // And the notifications keep flowing to it once it leads.
    survivor.leader.publish(jobNote('job-after-takeover'));
    expect(survivor.heard).toEqual([jobNote('job-after-takeover')]);
  }, 15_000);
});

describe('two tabs that both believe they lead', () => {
  it('converge on one within a heartbeat, and the larger id is the one that yields', async () => {
    const survivor = openTab();
    await wait(AFTER_ELECTION_MS);
    expect(survivor.leader.isLeader()).toBe(true);

    // The suspended tab waking up: it never stopped believing it was leader, so its first act is a
    // heartbeat. An id ordered *below* this tab's, so this tab is the one that must yield.
    const woken = openPeer(`${survivor.leader.id}-but-smaller`.replace(/^./, '!'));
    woken.beat();
    await wait(50);

    expect(survivor.leader.isLeader()).toBe(false);
  });

  it('does not yield to the larger one, or both would step down and nobody would watch', async () => {
    const survivor = openTab();
    await wait(AFTER_ELECTION_MS);
    expect(survivor.leader.isLeader()).toBe(true);

    // The other half of the same total order. Getting this wrong symmetrically — "someone else is
    // leading, so I stop" — is how an election ends with zero leaders and silent notifications.
    const woken = openPeer('￿-larger-than-any-uuid');
    woken.beat();
    await wait(50);

    expect(survivor.leader.isLeader()).toBe(true);
  });
});

describe('a browser with no BroadcastChannel', () => {
  it('lets every tab lead, which is what this app did before there was an election', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    try {
      const a = openTab();
      const b = openTab();

      // Immediately, with no campaign: there is nobody to campaign against and nothing to wait
      // for. The alternative — treating "cannot coordinate" as "must not watch" — would turn a
      // missing browser API into silence about a job a chemist is waiting on.
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

describe('a tab that lost the election', () => {
  it('opens no stream at all, which is the whole point of the cap arithmetic', async () => {
    const peer = openPeer('0000-leader');
    peer.keepAlive();

    const { unmount } = renderHook(() => useJobStreams());
    try {
      await wait(AFTER_ELECTION_MS);
      // Not "fewer streams" — none. `service_max_event_streams_per_user` is 5 and a leader spends
      // 3; a follower spending even one would put two windows back over the cap on the third tab.
      expect(connects).toBe(0);
    } finally {
      unmount();
    }
  });

  it('still gets the notification the leader saw', async () => {
    const peer = openPeer('0000-leader');
    peer.keepAlive();

    const { unmount } = renderHook(() => useJobStreams());
    try {
      await wait(AFTER_ELECTION_MS);
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

  it('opens the streams itself once the leader resigns', async () => {
    const peer = openPeer('0000-leader');
    peer.keepAlive();

    const { unmount } = renderHook(() => useJobStreams());
    try {
      await wait(AFTER_ELECTION_MS);
      expect(connects).toBe(0);

      peer.goSilent();
      peer.resign();
      await wait(AFTER_ELECTION_MS);

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
    timeout: TAKEOVER_DEADLINE_MS,
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
      await vi.advanceTimersByTimeAsync(AFTER_ELECTION_MS);
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

  it('reclaims the slot when the tab that asked for it stops saying so', async () => {
    seedConversations([SID, SID2, SID3]);
    const follower = openPeer('zzzz-follower');
    follower.keepDeclaring([SID4]);

    const { unmount } = renderHook(() => useJobStreams());
    try {
      await holds([SID, SID4, SID2]);

      // The follower crashes — no resignation, nothing announced, which is the only shape a crash
      // has from here. Without an expiry its claim on a stream would outlive the tab that made it,
      // and the leader would hold one of three streams for a window nobody is looking at.
      follower.goSilent();
      await holds([SID, SID2, SID3]);
    } finally {
      unmount();
    }
  }, 15_000);

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
        await vi.advanceTimersByTimeAsync(AFTER_ELECTION_MS);
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
    leader.keepAlive();

    const { unmount } = renderHook(() => useJobStreams());
    try {
      await wait(AFTER_ELECTION_MS);
      expect(useChatStore.getState().jobStreamsFailing).toEqual([]);

      leader.note({ kind: 'health', failing: [SID], throttled: true });
      await vi.waitFor(() => expect(useChatStore.getState().jobStreamsFailing).toEqual([SID]));
      // The throttle travels too. It is the one flag that only ever moves one way, so a tab that
      // is told the account is over the cap does not un-tell itself.
      expect(useChatStore.getState().jobStreamsThrottled).toBe(true);

      leader.note({ kind: 'health', failing: [], throttled: false });
      await vi.waitFor(() => expect(useChatStore.getState().jobStreamsFailing).toEqual([]));
      expect(useChatStore.getState().jobStreamsThrottled).toBe(true);
    } finally {
      unmount();
    }
  });

  it('does not outlive the leader that reported it', async () => {
    // A failure warning describes streams the departed tab was holding. The ones this tab is about
    // to open have not failed at anything — so a takeover that kept the warning would pin a red
    // indicator on a healthy account until somebody reloaded the page, and the chemist would be
    // told notifications were broken while they were arriving.
    const leader = openPeer('0000-leader');
    leader.keepAlive();

    const { unmount } = renderHook(() => useJobStreams());
    try {
      await wait(AFTER_ELECTION_MS);
      leader.note({ kind: 'health', failing: [SID], throttled: false });
      await vi.waitFor(() => expect(useChatStore.getState().jobStreamsFailing).toEqual([SID]));

      leader.received.length = 0;
      leader.goSilent();
      leader.resign();

      await vi.waitFor(() => expect(useChatStore.getState().jobStreamsFailing).toEqual([]), {
        timeout: TAKEOVER_DEADLINE_MS,
        interval: 50,
      });
      // And it says so, rather than clearing it privately: a third tab is carrying the same stale
      // warning and has no other way to hear that it is over.
      expect(leader.received).toContainEqual({
        type: 'note',
        from: expect.any(String),
        note: { kind: 'health', failing: [], throttled: false },
      });
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
        { timeout: TAKEOVER_DEADLINE_MS, interval: 50 },
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
