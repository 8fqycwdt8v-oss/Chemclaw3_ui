/**
 * What detach recovery can and cannot tell apart, by turn identity and by text.
 *
 * `recoverDetachedAnswer` matches the turn's own `correlationId` against the `correlation_id` a
 * service stamps on each transcript row. Against an older service that sends none — or a turn whose
 * response header never arrived — it falls back to anchoring on answer *text*, and two cases fall
 * through that anchor and poll to the deadline with the answer already in the transcript:
 *
 *  1. **No held answer** (the previous turn aborted or failed, so it left none here). The first
 *     read becomes the anchor — and when the service finished this turn before that read, the
 *     anchor *is* this turn's answer.
 *  2. **This turn's answer is byte-identical to the held one** — a repeated question with a
 *     deterministic answer — so "differs from what we hold" is never true.
 *
 * The shortcut that looks like a fix for (1) under text alone — accept a newest exchange whose
 * question matches when nothing is held — is deliberately not taken: a retry usually repeats the
 * question, so it would bind the aborted turn's own stored answer into this one. Both cases are
 * pinned twice below: missed without an id, found with one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type TranscriptMessage } from '../src/api/client.ts';
import { recoverDetachedAnswer } from '../src/state/sendMessage.ts';
import type { AuthProvider } from '../src/auth/types.ts';

const SID = 'r'.repeat(32);
const auth = { getAccessToken: async () => null } as unknown as AuthProvider;

/** Past the 630 s wall clock and the worst jittered wait that can start inside it. */
const PAST_THE_DEADLINE_MS = 700_000;

/** Pairs as an older service sends them: no `correlation_id` key at all. */
const transcript = (...pairs: [string, string][]): TranscriptMessage[] =>
  pairs.flatMap(([q, a], i) => [
    { index: 2 * i, role: 'user', text: q, tool_calls: [] },
    { index: 2 * i + 1, role: 'assistant', text: a, tool_calls: [] },
  ]);

/** Pairs as a current service sends them, each stamped with the turn that stored it. */
const stamped = (...pairs: [string, string, string | null][]): TranscriptMessage[] =>
  pairs.flatMap(([q, a, turn], i) => [
    { index: 2 * i, role: 'user', text: q, tool_calls: [], correlation_id: turn },
    { index: 2 * i + 1, role: 'assistant', text: a, tool_calls: [], correlation_id: turn },
  ]);

const THIS_TURN = 'c'.repeat(32);

async function recover(held: string | null, correlationId = ''): Promise<string | null> {
  const pending = recoverDetachedAnswer(
    SID,
    'pKa of phenol?',
    held,
    correlationId,
    new AbortController().signal,
    auth,
  );
  await vi.advanceTimersByTimeAsync(PAST_THE_DEADLINE_MS);
  return pending;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('detach recovery against a service that sends no turn id: anchored on text', () => {
  it('finds an answer that arrives after it starts, which is the case it is for', async () => {
    let reads = 0;
    vi.spyOn(api, 'getMessages').mockImplementation(async () => {
      reads += 1;
      return reads < 3
        ? transcript(['earlier?', 'earlier answer'])
        : transcript(['earlier?', 'earlier answer'], ['pKa of phenol?', 'about 10']);
    });
    expect(await recover('earlier answer')).toBe('about 10');
  });

  it('LIMITATION: misses this turn’s answer when nothing was held and it landed before the first read', async () => {
    vi.spyOn(api, 'getMessages').mockResolvedValue(
      transcript(['earlier?', ''], ['pKa of phenol?', 'about 10']),
    );
    expect(await recover(null)).toBeNull();
  });

  it('LIMITATION: misses an answer byte-identical to the one it holds', async () => {
    vi.spyOn(api, 'getMessages').mockResolvedValue(
      transcript(['pKa of phenol?', 'about 10'], ['pKa of phenol?', 'about 10']),
    );
    expect(await recover('about 10')).toBeNull();
  });
});

describe('detach recovery by turn identity, when the service stamps its rows', () => {
  it('finds this turn’s answer that landed before the first read with nothing held', async () => {
    vi.spyOn(api, 'getMessages').mockResolvedValue(
      stamped(['earlier?', '', 'a'.repeat(32)], ['pKa of phenol?', 'about 10', THIS_TURN]),
    );
    expect(await recover(null, THIS_TURN)).toBe('about 10');
  });

  it('finds an answer byte-identical to the one it holds', async () => {
    vi.spyOn(api, 'getMessages').mockResolvedValue(
      stamped(
        ['pKa of phenol?', 'about 10', 'a'.repeat(32)],
        ['pKa of phenol?', 'about 10', THIS_TURN],
      ),
    );
    expect(await recover('about 10', THIS_TURN)).toBe('about 10');
  });

  it('refuses a newer answer stamped with another turn, however its text reads', async () => {
    // A retry repeats its question; the aborted first attempt's answer landing after recovery
    // started differs from what is held and matches the question — text alone would take it.
    let reads = 0;
    vi.spyOn(api, 'getMessages').mockImplementation(async () => {
      reads += 1;
      return reads < 3
        ? stamped(['earlier?', 'earlier answer', 'e'.repeat(32)])
        : stamped(
            ['earlier?', 'earlier answer', 'e'.repeat(32)],
            ['pKa of phenol?', 'the aborted attempt’s answer', 'a'.repeat(32)],
          );
    });
    expect(await recover('earlier answer', THIS_TURN)).toBeNull();
  });

  it('falls back to text for a row stored without an id', async () => {
    let reads = 0;
    vi.spyOn(api, 'getMessages').mockImplementation(async () => {
      reads += 1;
      return reads < 3
        ? stamped(['earlier?', 'earlier answer', null])
        : stamped(['earlier?', 'earlier answer', null], ['pKa of phenol?', 'about 10', null]);
    });
    expect(await recover('earlier answer', THIS_TURN)).toBe('about 10');
  });

  it('falls back to text when the turn’s own id never arrived', async () => {
    vi.spyOn(api, 'getMessages').mockResolvedValue(
      stamped(['earlier?', '', 'a'.repeat(32)], ['pKa of phenol?', 'about 10', THIS_TURN]),
    );
    expect(await recover(null, '')).toBeNull();
  });
});
