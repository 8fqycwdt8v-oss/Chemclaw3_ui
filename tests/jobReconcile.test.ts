/**
 * `ISSUES.md` Issue 12: which runs a new leader asks the registry about, and what it makes of the
 * answer. The wiring — a real election, a leader dying mid-frame, the next one recovering the
 * ending through `GET /jobs/{id}` — is driven in `tests/jobStreamElection.test.ts`; this file holds
 * the bounds, because they are what keeps a takeover from becoming a burst of reads or a card for
 * news that is a week old.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  RECONCILE_MAX_JOBS,
  RECONCILE_WINDOW_MS,
  awaitedJobs,
  reconcileAfterTakeover,
  terminalEventFrom,
} from '../src/state/jobReconcile.ts';
import type { ChatState } from '../src/state/chatStore.ts';
import type { DurableJobStatus } from '../src/api/client.ts';
import type { Note, StreamLeader } from '../src/state/jobStreamLeader.ts';

const NOW = 1_800_000_000_000;
const SID = 'a'.repeat(32);

type Row = { kind: string; at: number; job?: object; jobFailure?: object };

const launch = (jobId: string, at = NOW - 1_000, settled = false): Row => ({
  kind: 'job_started',
  at,
  job: { jobId, settled },
});

function state(
  conversations: { sessionId: string | null; trace: Row[] }[],
  fedIds: string[] = [],
): ChatState {
  return {
    conversations: Object.fromEntries(
      conversations.map((c, i) => [
        `c${i}`,
        {
          id: `c${i}`,
          sessionId: c.sessionId,
          messages: [
            { id: `u${i}`, role: 'user', text: 'x' },
            {
              id: `a${i}`,
              role: 'assistant',
              trace: c.trace.map((row, j) => ({ id: `t${i}-${j}`, ...row })),
            },
          ],
        },
      ]),
    ),
    jobFeed: fedIds.map((job_id) => ({
      event: { type: 'job_completed', job_id, summary: {} },
      sessionId: SID,
    })),
  } as unknown as ChatState;
}

const status = (over: Partial<DurableJobStatus>): DurableJobStatus => ({
  job_id: 'j',
  status: 'running',
  summary: null,
  result: {},
  calc_refs: [],
  rationale: '',
  ...over,
});

describe('which runs are awaited', () => {
  it('is every launch this store has not seen end, newest first', () => {
    const awaited = awaitedJobs(
      state(
        [
          {
            sessionId: SID,
            trace: [
              launch('older', NOW - 5_000),
              launch('newer', NOW - 1_000),
              launch('settled-in-turn', NOW - 1_000, true),
              launch('ended-in-trace'),
              { kind: 'job_completed', at: NOW, job: { jobId: 'ended-in-trace' } },
              launch('failed-in-trace'),
              { kind: 'job_failed', at: NOW, jobFailure: { jobId: 'failed-in-trace', reason: '' } },
              launch('already-a-card'),
            ],
          },
        ],
        ['already-a-card'],
      ),
      NOW,
    );
    expect(awaited.map((job) => job.jobId)).toEqual(['newer', 'older']);
    expect(awaited.every((job) => job.sessionId === SID)).toBe(true);
  });

  it('skips a conversation with no session, because an ending there has nowhere to be filed', () => {
    expect(awaitedJobs(state([{ sessionId: null, trace: [launch('orphan')] }]), NOW)).toEqual([]);
  });

  it('does not reach past the job feed’s own retention', () => {
    // A launch older than the feed keeps cards for: its ending would be aged out on the next
    // persist, and one whose card already aged out would be announced again as news.
    const awaited = awaitedJobs(
      state([
        {
          sessionId: SID,
          trace: [
            launch('inside', NOW - RECONCILE_WINDOW_MS + 60_000),
            launch('outside', NOW - RECONCILE_WINDOW_MS - 60_000),
          ],
        },
      ]),
      NOW,
    );
    expect(awaited.map((job) => job.jobId)).toEqual(['inside']);
  });

  it('asks about at most a bounded number, the newest', () => {
    const many = Array.from({ length: RECONCILE_MAX_JOBS + 5 }, (_, i) =>
      launch(`job-${i}`, NOW - i * 1_000),
    );
    const awaited = awaitedJobs(state([{ sessionId: SID, trace: many }]), NOW);
    expect(awaited).toHaveLength(RECONCILE_MAX_JOBS);
    expect(awaited[0]!.jobId).toBe('job-0');
  });
});

describe('what the registry’s answer becomes', () => {
  it('is nothing while the run is still going — the stream is still the channel for it', () => {
    expect(terminalEventFrom(status({ status: 'running' }))).toBeNull();
  });

  it('is a completion carrying the run’s result', () => {
    expect(
      terminalEventFrom(status({ job_id: 'j1', status: 'completed', result: { converged: true } })),
    ).toEqual({ type: 'job_completed', job_id: 'j1', summary: { converged: true } });
  });

  it.each([
    ['failed', 'SCF did not converge', 'SCF did not converge'],
    ['timed_out', null, 'timed_out'],
    ['terminated', '', 'terminated'],
  ])('is a failure for %s, with the cause or the state word', (word, summary, reason) => {
    expect(terminalEventFrom(status({ job_id: 'j2', status: word, summary }))).toEqual({
      type: 'job_failed',
      job_id: 'j2',
      reason,
    });
  });
});

describe('reconciling', () => {
  const tab = (): StreamLeader & { notes: Note[] } => {
    const notes: Note[] = [];
    return {
      notes,
      id: 't',
      isLeader: () => true,
      declare: () => undefined,
      watched: () => [],
      subscribe: () => () => undefined,
      publish: (note: Note) => notes.push(note),
      close: () => undefined,
    };
  };

  it('publishes the endings, skips the rest, and never rejects on a failed read', async () => {
    const leader = tab();
    const getJob = vi.fn(async (jobId: string) => {
      if (jobId === 'done') return status({ job_id: 'done', status: 'completed' });
      if (jobId === 'going') return status({ job_id: 'going', status: 'running' });
      throw new Error('503 from the durable subsystem');
    });
    const published = await reconcileAfterTakeover(
      leader,
      state([{ sessionId: SID, trace: [launch('done'), launch('going'), launch('broken')] }]),
      async () => null,
      getJob,
    );
    expect(published).toBe(1);
    expect(getJob).toHaveBeenCalledTimes(3);
    expect(leader.notes).toEqual([
      {
        kind: 'job',
        event: { type: 'job_completed', job_id: 'done', summary: {} },
        sessionId: SID,
      },
    ]);
  });

  it('reads nothing when nothing is awaited', async () => {
    const getJob = vi.fn();
    expect(await reconcileAfterTakeover(tab(), state([]), async () => null, getJob)).toBe(0);
    expect(getJob).not.toHaveBeenCalled();
  });
});
