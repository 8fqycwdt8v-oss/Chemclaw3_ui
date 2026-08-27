/**
 * What the turn is doing, and what it did.
 *
 * The derivation is a pure function precisely so it can be pinned here rather than through a
 * rendered bubble, and two of these tests are about *ranking* rather than about any single state:
 * a turn is frequently several things at once — a durable job running while the model writes — and
 * the row has to name the one the reader is waiting on.
 *
 * The last group is the one that would otherwise rot quietly. A plan-gate refusal is the control
 * working, and counting it beside a failed call reports a correctly-gated turn as a broken one —
 * the mistake the service's own live evaluation made before `tool_failed.reason` existed. Nothing
 * about the rendering catches that; a count does.
 */

import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  planPosition,
  summarizeTurn,
  turnActivity,
} from '../src/state/turnActivity.ts';
import type { AssistantMessage, TraceEntry } from '../src/state/types.ts';

let seq = 0;
const entry = (over: Partial<TraceEntry> & Pick<TraceEntry, 'kind'>): TraceEntry => ({
  id: `e${(seq += 1)}`,
  at: 0,
  ...over,
});

const openCall = (tool: string): TraceEntry =>
  entry({ kind: 'tool_call', toolCall: { tool, arguments: '{}' } });

const closedCall = (tool: string): TraceEntry =>
  entry({ kind: 'tool_call', toolCall: { tool, arguments: '{}', result: 'ok', endedAt: 4000 } });

const message = (over: Partial<AssistantMessage> = {}): AssistantMessage =>
  ({
    id: 'a1',
    role: 'assistant',
    at: 0,
    status: 'streaming',
    streamedText: '',
    finalText: null,
    confidence: null,
    unsupportedClaims: [],
    reviewRequired: false,
    verifiedBy: null,
    degradedConnectors: [],
    partialReason: null,
    queued: false,
    trace: [],
    latestPlan: null,
    latestPlanHash: null,
    error: null,
    ...over,
  }) as AssistantMessage;

describe('planPosition', () => {
  it('is the first step not marked done', () => {
    expect(planPosition(['[x] one', '[x] two', '[ ] three', '[ ] four'])).toEqual({
      index: 3,
      total: 4,
      text: 'three',
    });
  });

  it('reports nothing for a plan with no status prefixes', () => {
    // `GET /sessions/{id}/plan` returns bare step text, so a plan restored after a reload has no
    // position to report. Claiming "step 1 of 2" for it would invent a completion state nobody
    // sent — and the strip would then tick over as the reader watched, from data that never moved.
    expect(planPosition(['compute the pKa', 'propose a note'])).toBeNull();
  });

  it('reports nothing once every step is done', () => {
    expect(planPosition(['[x] one', '[x] two'])).toBeNull();
  });

  it('reports nothing for an empty or absent plan', () => {
    expect(planPosition([])).toBeNull();
    expect(planPosition(null)).toBeNull();
  });
});

describe('turnActivity', () => {
  it('names the admission queue only before anything has happened', () => {
    expect(turnActivity(message({ queued: true })).kind).toBe('queued');
    // `queued` is never retracted by the service, so a turn that waited two seconds and has since
    // called a tool must not still read as waiting for a slot.
    expect(turnActivity(message({ queued: true, trace: [openCall('predict_pka')] })).kind).toBe(
      'tool',
    );
  });

  it('names the open call above the tokens, because that is what the turn is blocked on', () => {
    const activity = turnActivity(
      message({ streamedText: 'The pKa ', trace: [openCall('predict_pka')] }),
    );
    expect(activity.kind).toBe('tool');
    expect(activity.detail).toBe('predict_pka');
  });

  it('names the tokens above a running durable job, because the job does not block the turn', () => {
    const activity = turnActivity(
      message({
        streamedText: 'The pKa ',
        trace: [entry({ kind: 'job_started', job: { jobId: 'calc-1', kind: 'calc' } })],
      }),
    );
    expect(activity.kind).toBe('writing');
  });

  it('names the durable job, and the plan step it was launched for', () => {
    const activity = turnActivity(
      message({
        latestPlan: ['[x] screen', '[ ] estimate the pKa'],
        trace: [
          closedCall('screen_hazards'),
          entry({
            kind: 'job_started',
            job: { jobId: 'calc-9f2c', kind: 'calc', planStep: 'estimate the pKa' },
          }),
        ],
      }),
    );
    expect(activity.kind).toBe('job');
    // The join `job_started.plan_step` exists for: "a job is running" becomes "step 2 is".
    expect(activity.label).toBe('estimate the pKa');
    expect(activity.detail).toBe('calc-9f2c');
    // Somebody else's clock, so the dot does not pulse.
    expect(activity.tone).toBe('waiting');
  });

  it('falls back to thinking, with the plan position when there is one', () => {
    const activity = turnActivity(message({ latestPlan: ['[ ] one', '[ ] two'] }));
    expect(activity.kind).toBe('thinking');
    expect(activity.step).toEqual({ index: 1, total: 2, text: 'one' });
  });
});

describe('summarizeTurn', () => {
  it('counts a gate refusal apart from a failure', () => {
    const summary = summarizeTurn([
      closedCall('screen_hazards'),
      entry({
        kind: 'tool_failed',
        toolFailure: { tool: 'submit_qm_job', message: 'held', reason: 'plan_gate' },
      }),
      entry({ kind: 'tool_failed', toolFailure: { tool: 'predict_pka', message: 'timeout' } }),
      entry({
        kind: 'evidence_source',
        evidenceSource: { source: 'lexical', chunks: 0, failed: true },
      }),
    ]);
    expect(summary.held).toBe(1);
    // The timeout and the broken retriever; the refusal is not one of them.
    expect(summary.problems).toBe(2);
  });

  it('does not count a source that was asked and had nothing as a problem', () => {
    const summary = summarizeTurn([
      entry({
        kind: 'evidence_source',
        evidenceSource: { source: 'graph', chunks: 0, failed: false },
      }),
    ]);
    expect(summary.problems).toBe(0);
  });

  it('counts calls and jobs', () => {
    const summary = summarizeTurn([
      closedCall('a'),
      closedCall('b'),
      entry({ kind: 'job_started', job: { jobId: 'j1' } }),
    ]);
    expect(summary).toMatchObject({ steps: 3, toolCalls: 2, jobs: 1 });
  });
});

describe('formatDuration', () => {
  it('says whole seconds under a minute and m ss above', () => {
    expect(formatDuration(4200)).toBe('4s');
    expect(formatDuration(200)).toBe('0s');
    expect(formatDuration(221_000)).toBe('3m 41s');
  });

  it('says nothing for a duration that cannot be one', () => {
    expect(formatDuration(-1)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
  });
});
