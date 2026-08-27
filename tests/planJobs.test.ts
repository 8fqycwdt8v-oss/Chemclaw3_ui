/**
 * The step↔job derivation behind the plan card's chips.
 *
 * The subtlety worth pinning: a durable job's ending arrives on two different channels. Inside
 * the turn it is a trace row on the same message; after the turn — the normal case — it lands in
 * the global `jobFeed` via the session event stream and never touches the trace. A derivation
 * that read only the trace would leave "job running" on screen forever for exactly the jobs the
 * chip exists for, so both channels are exercised here.
 */

import { describe, expect, it } from 'vitest';
import { normalizeEvent } from '../shared/events.ts';
import type { JobFeedItem } from '../src/state/chatStore.ts';
import { planStepJobs } from '../src/state/planJobs.ts';
import type { TraceEntry } from '../src/state/types.ts';

let nextId = 0;
const entry = (partial: Omit<TraceEntry, 'id' | 'at'>): TraceEntry => ({
  id: `t-${nextId++}`,
  at: nextId,
  ...partial,
});

const started = (jobId: string, planStep?: string): TraceEntry =>
  entry({ kind: 'job_started', job: { jobId, kind: 'calc', ...(planStep ? { planStep } : {}) } });

const feedItem = (jobId: string, type: 'job_completed' | 'job_failed'): JobFeedItem => ({
  event:
    type === 'job_completed'
      ? { type, job_id: jobId, summary: {} }
      : { type, job_id: jobId, reason: 'boom' },
  sessionId: 's1',
  conversationId: null,
  receivedAt: 0,
  seen: false,
  dismissed: false,
});

describe('planStepJobs', () => {
  it('marks a launched, unfinished job as running on its step', () => {
    const jobs = planStepJobs([started('j1', 'run the conformer search')], []);
    expect(jobs.get('run the conformer search')).toBe('running');
  });

  it('ignores a launch that named no step', () => {
    expect(planStepJobs([started('j1')], []).size).toBe(0);
  });

  it('settles a step from the trace when the job ended inside the turn', () => {
    const trace = [
      started('j1', 'step A'),
      entry({ kind: 'job_completed', job: { jobId: 'j1', summary: {} } }),
      started('j2', 'step B'),
      entry({ kind: 'job_failed', jobFailure: { jobId: 'j2', reason: 'no such solvent' } }),
    ];
    const jobs = planStepJobs(trace, []);
    expect(jobs.get('step A')).toBe('done');
    expect(jobs.get('step B')).toBe('failed');
  });

  it('settles a step from the job feed when the job outlived its turn', () => {
    const trace = [started('j1', 'step A'), started('j2', 'step B')];
    const feed = [feedItem('j1', 'job_completed'), feedItem('j2', 'job_failed')];
    const jobs = planStepJobs(trace, feed);
    expect(jobs.get('step A')).toBe('done');
    expect(jobs.get('step B')).toBe('failed');
  });

  it('keeps a step running while any of its jobs still is', () => {
    const trace = [started('j1', 'step A'), started('j2', 'step A')];
    const jobs = planStepJobs(trace, [feedItem('j1', 'job_completed')]);
    expect(jobs.get('step A')).toBe('running');
  });
});

describe('the plan_step field on the wire', () => {
  it('survives normalizeEvent, and defaults to empty rather than to undefined', () => {
    const carried = normalizeEvent({
      type: 'job_started',
      job_id: 'j1',
      kind: 'calc',
      plan_step: 'run the conformer search',
    });
    expect(carried).toEqual({
      type: 'job_started',
      job_id: 'j1',
      kind: 'calc',
      plan_step: 'run the conformer search',
    });
    // An older service sends no plan_step; the normaliser fills the field in rather than leaving
    // a hole the trace mapping would have to branch on.
    const bare = normalizeEvent({ type: 'job_started', job_id: 'j1', kind: 'calc' });
    expect(bare).toEqual({ type: 'job_started', job_id: 'j1', kind: 'calc', plan_step: '' });
  });
});
