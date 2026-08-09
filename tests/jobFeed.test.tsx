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
import { MemoryRouter } from 'react-router';
import { useChatStore } from '../src/state/chatStore.ts';
import { JobFeed } from '../src/components/JobFeed.tsx';
import type { JobCompletedEvent } from '../shared/events.ts';

const completion = (jobId: string, extra: Record<string, unknown> = {}): JobCompletedEvent => ({
  type: 'job_completed',
  job_id: jobId,
  summary: { molecule_smiles: 'CCO', total_energy_hartree: -154.5, converged: true, ...extra },
});

const SID = 'a'.repeat(32);

/** Completions arrive on a stream we opened, so the session is part of the call now. */
const push = (event: ReturnType<typeof completion>): void =>
  useChatStore.getState().pushJobCompleted(event, SID);

/** JobFeed links back to the conversation a job came from, so it needs a router. */
const renderFeed = () =>
  render(
    <MemoryRouter>
      <JobFeed />
    </MemoryRouter>,
  );

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
    notifyOnJobComplete: false,
    streaming: null,
  });
});

describe('jobFeed store', () => {
  it('keeps completions newest-first', () => {
    push(completion('qm-1'));
    push(completion('qm-2'));
    expect(useChatStore.getState().jobFeed.map((j) => j.event.job_id)).toEqual(['qm-2', 'qm-1']);
  });

  it('does not stack a redelivered completion twice', () => {
    // The push-back stream reconnects with backoff and delivery is at-least-once, so the same
    // completion can legitimately arrive again. Two identical cards would read as two jobs.
    push(completion('qm-1'));
    push(completion('qm-1'));
    expect(useChatStore.getState().jobFeed).toHaveLength(1);
  });

  it('a redelivered completion keeps its original position and time', () => {
    // Now that the feed is persisted this is the difference between a stable list and one that
    // reshuffles on every reconnect: a filter-then-unshift would put a three-day-old card back at
    // the top, above completions that genuinely arrived since, and restamp it as new.
    push(completion('qm-old'));
    const original = useChatStore.getState().jobFeed[0]?.receivedAt ?? 0;
    push(completion('qm-new'));

    push(completion('qm-old'));

    const feed = useChatStore.getState().jobFeed;
    expect(feed.map((j) => j.event.job_id)).toEqual(['qm-new', 'qm-old']);
    expect(feed[1]?.receivedAt).toBe(original);
  });

  it('a redelivered completion does not un-see or un-dismiss itself', () => {
    // Otherwise the badge count climbs again on every reconnect for work already read, and a
    // dismissed card comes back.
    push(completion('qm-1'));
    useChatStore.getState().dismissJobCompleted('qm-1');

    push(completion('qm-1'));

    expect(useChatStore.getState().jobFeed[0]?.dismissed).toBe(true);
    expect(useChatStore.getState().jobFeed[0]?.seen).toBe(true);
  });

  it('dismisses only the named job', () => {
    push(completion('qm-1'));
    push(completion('qm-2'));
    useChatStore.getState().dismissJobCompleted('qm-1');
    // Dismissal is a flag now, not a delete: the feed is durable, so destroying the only copy on
    // one click would be unrecoverable.
    expect(
      useChatStore
        .getState()
        .jobFeed.filter((j) => !j.dismissed)
        .map((j) => j.event.job_id),
    ).toEqual(['qm-2']);
  });
});

describe('JobFeed', () => {
  it('renders nothing when no job has finished', () => {
    const { container } = renderFeed();
    expect(container.firstChild).toBeNull();
  });

  it('shows a finished job with its id and result', () => {
    push(completion('qm-abc123'));
    renderFeed();
    expect(screen.getByText('qm-abc123')).toBeTruthy();
    expect(screen.getByText('converged')).toBeTruthy();
  });

  it('marks a non-converged run rather than presenting it as a result', () => {
    push(completion('qm-bad', { converged: false }));
    renderFeed();
    expect(screen.getByText('not converged')).toBeTruthy();
  });

  it('survives a summary that carries none of the fields it looks for', () => {
    // The payload is whatever the job put in it; a different job kind must degrade to its id
    // rather than throwing and taking the conversation down with it.
    useChatStore.setState({
      jobFeed: [
        {
          event: { type: 'job_completed', job_id: 'report-9', summary: {} },
          sessionId: SID,
          conversationId: null,
          receivedAt: Date.now(),
          seen: false,
          dismissed: false,
        },
      ],
    });
    renderFeed();
    expect(screen.getByText('report-9')).toBeTruthy();
  });

  it('dismissing a card removes it from the screen', () => {
    push(completion('qm-abc123'));
    renderFeed();
    fireEvent.click(screen.getByLabelText('Dismiss job qm-abc123'));
    expect(screen.queryByText('qm-abc123')).toBeNull();
  });
});
