/**
 * Cross-turn job completions reach the screen.
 *
 * `useJobFeed` has always consumed `GET /sessions/{id}/events` and written each completion into
 * `jobFeed` — and until now nothing rendered it, so a DFT run that finished after its turn ended
 * was invisible however well the backend delivered it. These tests cover the store contract and
 * the component, which is where that gap actually was.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useChatStore } from '../src/state/chatStore.ts';
import { JobFeed } from '../src/components/JobFeed.tsx';
import type { JobCompletedEvent } from '../shared/events.ts';

const completion = (jobId: string, extra: Record<string, unknown> = {}): JobCompletedEvent => ({
  type: 'job_completed',
  job_id: jobId,
  summary: { molecule_smiles: 'CCO', total_energy_hartree: -154.5, converged: true, ...extra },
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
    useChatStore.getState().pushJobEvent(completion('qm-1'));
    useChatStore.getState().pushJobEvent(completion('qm-2'));
    expect(useChatStore.getState().jobFeed.map((j) => j.job_id)).toEqual(['qm-2', 'qm-1']);
  });

  it('does not stack a redelivered completion twice', () => {
    // The push-back stream reconnects with backoff and delivery is at-least-once, so the same
    // completion can legitimately arrive again. Two identical cards would read as two jobs.
    useChatStore.getState().pushJobEvent(completion('qm-1'));
    useChatStore.getState().pushJobEvent(completion('qm-1'));
    expect(useChatStore.getState().jobFeed).toHaveLength(1);
  });

  it('dismisses only the named job', () => {
    useChatStore.getState().pushJobEvent(completion('qm-1'));
    useChatStore.getState().pushJobEvent(completion('qm-2'));
    useChatStore.getState().dismissJobEvent('qm-1');
    expect(useChatStore.getState().jobFeed.map((j) => j.job_id)).toEqual(['qm-2']);
  });
});

describe('JobFeed', () => {
  it('renders nothing when no job has finished', () => {
    const { container } = render(<JobFeed />);
    expect(container.firstChild).toBeNull();
  });

  it('shows a finished job with its id and result', () => {
    useChatStore.getState().pushJobEvent(completion('qm-abc123'));
    render(<JobFeed />);
    expect(screen.getByText('qm-abc123')).toBeTruthy();
    expect(screen.getByText('converged')).toBeTruthy();
  });

  it('marks a non-converged run rather than presenting it as a result', () => {
    useChatStore.getState().pushJobEvent(completion('qm-bad', { converged: false }));
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
    useChatStore.getState().pushJobEvent(completion('qm-abc123'));
    render(<JobFeed />);
    fireEvent.click(screen.getByLabelText('Dismiss job qm-abc123'));
    expect(screen.queryByText('qm-abc123')).toBeNull();
  });
});
