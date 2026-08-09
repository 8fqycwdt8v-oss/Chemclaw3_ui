/**
 * Cross-turn job outcomes reach the screen — both of them.
 *
 * `useJobFeed` has always consumed `GET /sessions/{id}/events` and written each completion into
 * `jobFeed` — and until recently nothing rendered it, so a DFT run that finished after its turn
 * ended was invisible however well the backend delivered it.
 *
 * The failure half was worse and lasted longer: `job_failed` was absent from the event mirror
 * entirely, so `normalizeEvent` dropped it and the hook never saw it. A job announced as running
 * and then failed kept its "runs asynchronously" label for the rest of the conversation. Because
 * the backend's mailbox claim is destructive and covers both kinds, dropping it here did not leave
 * the row for another consumer — it destroyed it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { normalizeEvent, type JobCompletedEvent, type JobFailedEvent } from '../shared/events.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import { JobFeed } from '../src/components/JobFeed.tsx';

const completion = (jobId: string, extra: Record<string, unknown> = {}): JobCompletedEvent => ({
  type: 'job_completed',
  job_id: jobId,
  summary: { molecule_smiles: 'CCO', total_energy_hartree: -154.5, converged: true, ...extra },
});

const failure = (jobId: string, reason = 'the cluster rejected the job'): JobFailedEvent => ({
  type: 'job_failed',
  job_id: jobId,
  reason,
});

beforeEach(() => {
  // Explicit, because auto-cleanup only registers when vitest runs with `globals: true`; without
  // it each render stacks on the last and every query finds two of everything.
  cleanup();
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

describe('jobFeed store', () => {
  it('keeps completions newest-first', () => {
    useChatStore.getState().pushJobOutcome(completion('qm-1'));
    useChatStore.getState().pushJobOutcome(completion('qm-2'));
    expect(useChatStore.getState().jobFeed.map((j) => j.job_id)).toEqual(['qm-2', 'qm-1']);
  });

  it('does not stack a redelivered completion twice', () => {
    // The push-back stream reconnects with backoff and delivery is at-least-once, so the same
    // completion can legitimately arrive again. Two identical cards would read as two jobs.
    useChatStore.getState().pushJobOutcome(completion('qm-1'));
    useChatStore.getState().pushJobOutcome(completion('qm-1'));
    expect(useChatStore.getState().jobFeed).toHaveLength(1);
  });

  it('dismisses only the named job', () => {
    useChatStore.getState().pushJobOutcome(completion('qm-1'));
    useChatStore.getState().pushJobOutcome(completion('qm-2'));
    useChatStore.getState().dismissJobOutcome('qm-1');
    expect(useChatStore.getState().jobFeed.map((j) => j.job_id)).toEqual(['qm-2']);
  });
});

describe('JobFeed', () => {
  it('renders nothing when no job has finished', () => {
    const { container } = render(<JobFeed />);
    expect(container.firstChild).toBeNull();
  });

  it('shows a finished job with its id and result', () => {
    useChatStore.getState().pushJobOutcome(completion('qm-abc123'));
    render(<JobFeed />);
    expect(screen.getByText('qm-abc123')).toBeTruthy();
    expect(screen.getByText('converged')).toBeTruthy();
  });

  it('marks a non-converged run rather than presenting it as a result', () => {
    useChatStore.getState().pushJobOutcome(completion('qm-bad', { converged: false }));
    render(<JobFeed />);
    expect(screen.getByText('not converged')).toBeTruthy();
  });

  it('survives a summary that carries none of the fields it looks for', () => {
    // The payload is whatever the job put in it; a different job kind must degrade to its id
    // rather than throwing and taking the conversation down with it.
    useChatStore.setState({
      jobFeed: [{ type: 'job_completed', job_id: 'report-9', summary: {} }],
    });
    render(<JobFeed />);
    expect(screen.getByText('report-9')).toBeTruthy();
  });

  it('dismissing a card removes it from the screen', () => {
    useChatStore.getState().pushJobOutcome(completion('qm-abc123'));
    render(<JobFeed />);
    fireEvent.click(screen.getByLabelText('Dismiss job qm-abc123'));
    expect(screen.queryByText('qm-abc123')).toBeNull();
  });
});

describe('a job that failed after its turn ended', () => {
  it('is a normalizable event at all', () => {
    // The regression that started this: `job_failed` was outside `EVENT_TYPES`, so it normalized
    // to null and every consumer downstream was unreachable by construction.
    expect(
      normalizeEvent({ type: 'job_failed', job_id: 'qm-9', reason: 'walltime exceeded' }),
    ).toEqual({ type: 'job_failed', job_id: 'qm-9', reason: 'walltime exceeded' });
  });

  it('says it failed, and why', () => {
    useChatStore.getState().pushJobOutcome(failure('qm-dead', 'xtb did not converge'));
    render(<JobFeed />);
    expect(screen.getByText('qm-dead')).toBeTruthy();
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.getByText('xtb did not converge')).toBeTruthy();
  });

  it('still says it failed when the service gave no reason', () => {
    // `reason` is defaulted server-side, so an empty one is reachable. The card must not fall
    // through to the completed branch and render a failure as a result.
    useChatStore.getState().pushJobOutcome(failure('qm-quiet', ''));
    render(<JobFeed />);
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.getByText('The service did not say why.')).toBeTruthy();
    expect(screen.queryByText('converged')).toBeNull();
  });

  it('shares the band with completions rather than needing a second place to look', () => {
    useChatStore.getState().pushJobOutcome(completion('qm-ok'));
    useChatStore.getState().pushJobOutcome(failure('qm-bad'));
    render(<JobFeed />);
    expect(screen.getByText('qm-ok')).toBeTruthy();
    expect(screen.getByText('qm-bad')).toBeTruthy();
    expect(screen.getByText('converged')).toBeTruthy();
    expect(screen.getByText('failed')).toBeTruthy();
  });
});
