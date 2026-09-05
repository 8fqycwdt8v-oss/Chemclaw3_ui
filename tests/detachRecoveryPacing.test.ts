/**
 * What detach recovery costs the service it is recovering from.
 *
 * A dropped turn stream puts this client into `recoverDetachedAnswer`, which reads the whole
 * transcript back until the detached turn's answer appears. That is the right behaviour — the turn
 * really is still running (`D-2026-08-27-a-disconnect-is-a-detach-not-a-stop`) — and the *cadence*
 * was not: a fixed 3 s interval, no jitter, and no backoff even while every request failed, for a
 * 630 s deadline. **210 unpaginated `GET /sessions/{id}/messages` per client.**
 *
 * The trigger is what makes that a herd rather than a nuisance. Any dropped turn stream enters this
 * loop, and the thing that drops every turn stream in the estate at the same instant is a backend
 * rolling restart — so at 50 turns in flight it is ~16.7 req/s of transcript reads, each one
 * `resolve_session`-gated and therefore a full session rehydrate, aimed at the pod that has just
 * come up. The condition that starts the loop is backend distress and what the loop does is add
 * load to a distressed backend.
 *
 * Both properties are asserted here because only one of them is about volume. The count is the
 * cost; the *spread* is what stops 200 clients from arriving together, and a fixed interval has a
 * perfectly good count and no spread at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../src/state/chatStore.ts';
import { sendMessage } from '../src/state/sendMessage.ts';
import type { AuthProvider } from '../src/auth/types.ts';
import { brokenSseResponse, sseFrames, stubFetch } from './helpers.ts';

const devAuth: AuthProvider = {
  mode: 'dev',
  account: null,
  getAccessToken: async () => null,
  login: async () => undefined,
  logout: async () => undefined,
  handleUnauthorized: async () => false,
};

/** The recovery deadline, which is the window every number below is measured over. */
const DEADLINE_MS = 630_000;

let restore: (() => void) | null = null;

beforeEach(() => {
  useChatStore.setState({
    conversations: {},
    order: [],
    activeId: null,
    composerLock: false,
    banner: null,
    jobFeed: [],
    streaming: null,
  });
});

afterEach(() => {
  restore?.();
  restore = null;
  vi.useRealTimers();
});

/**
 * Run one turn whose stream breaks, and record when each recovery poll was issued.
 *
 * The transcript never contains the answer, so recovery runs to its deadline — which is the worst
 * case and the one the measurement was taken on.
 */
async function pollTimesOverTheDeadline(): Promise<number[]> {
  const at: number[] = [];
  vi.useFakeTimers();
  // Offsets from the moment the clock was frozen, not wall-clock stamps: two runs start at
  // different real instants, so absolute times would differ for a reason that is not the jitter.
  const startedAt = Date.now();
  const stub = stubFetch((url, init) => {
    if (url.endsWith('/sessions') && init?.method === 'POST') {
      return new Response(JSON.stringify({ session_id: 'g'.repeat(32) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/messages') && (init?.method ?? 'GET') === 'GET') {
      at.push(Date.now() - startedAt);
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return brokenSseResponse(sseFrames([{ type: 'token', text: 'partial' }]));
  });
  restore = stub.restore;

  const cid = useChatStore.getState().createConversation();
  const turn = sendMessage({ conversationId: cid, text: 'pKa?', auth: devAuth });
  // Past the deadline by one full backoff: the loop's last wait may *begin* just inside 630 s and
  // run for another 30, and a run that is still sleeping when the clock stops never settles.
  await vi.advanceTimersByTimeAsync(DEADLINE_MS + 60_000);
  await turn;
  return at;
}

describe('the detached-turn recovery poll', () => {
  it('reads the transcript back tens of times, not hundreds', async () => {
    const at = await pollTimesOverTheDeadline();

    // Measured before: 210, one every 3 s for the whole deadline. The backoff reaches its 30 s
    // ceiling within five attempts and jitters between 15 and 30 s after that, so the worst case
    // is ~45 and the typical run is ~30.
    expect(at.length).toBeGreaterThan(5);
    expect(at.length).toBeLessThan(60);
  }, 30_000);

  it('still looks within the first few seconds, because most answers land early', async () => {
    const at = await pollTimesOverTheDeadline();

    // Backing off is only free if it does not delay the common case. The first wait is 1–2 s,
    // where the fixed schedule's was 3.
    expect(at[0]).toBeLessThanOrEqual(3_000);
  }, 30_000);

  it('spreads two clients that failed at the same instant', async () => {
    const first = await pollTimesOverTheDeadline();
    restore?.();
    restore = null;
    vi.useRealTimers();
    const second = await pollTimesOverTheDeadline();

    // The property that matters at 200 users, and the one a count cannot show: with a fixed
    // interval these two schedules are *identical*, so every client in the estate reads the
    // transcript at the same offset from the drop, 210 times over. Jitter makes them disagree —
    // and the assertion is on the whole schedule rather than on any one poll, because two runs
    // can coincide once by chance and cannot coincide throughout.
    const shared = first.filter((offset, i) => second[i] === offset).length;
    expect(shared).toBeLessThan(Math.min(first.length, second.length));
  }, 60_000);
});
