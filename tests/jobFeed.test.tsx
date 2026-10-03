/**
 * Cross-turn job completions reach the screen.
 *
 * `useJobFeed` has always consumed `GET /sessions/{id}/events` and written each completion into
 * `jobFeed` — and until now nothing rendered it, so a search that finished after its turn ended
 * was invisible however well the backend delivered it. These tests cover the store contract and
 * the component, which is where that gap actually was.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { useChatStore } from '../src/state/chatStore.ts';
import { JobFeed } from '../src/components/JobFeed.tsx';
import type { JobCompletedEvent, JobFailedEvent } from '../shared/events.ts';

const completion = (jobId: string, extra: Record<string, unknown> = {}): JobCompletedEvent => ({
  type: 'job_completed',
  job_id: jobId,
  summary: { molecule_smiles: 'CCO', total_energy_hartree: -154.5, converged: true, ...extra },
});

const failure = (jobId: string, reason = 'the solver did not converge'): JobFailedEvent => ({
  type: 'job_failed',
  job_id: jobId,
  reason,
});

const SID = 'a'.repeat(32);

/** Endings arrive on a stream we opened, so the session is part of the call now. */
const push = (event: JobCompletedEvent | JobFailedEvent): void =>
  useChatStore.getState().pushJobFinished(event, SID);

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
    push(completion('calc-1'));
    push(completion('calc-2'));
    expect(useChatStore.getState().jobFeed.map((j) => j.event.job_id)).toEqual([
      'calc-2',
      'calc-1',
    ]);
  });

  it('does not stack a redelivered completion twice', () => {
    // The push-back stream reconnects with backoff and delivery is at-least-once, so the same
    // completion can legitimately arrive again. Two identical cards would read as two jobs.
    push(completion('calc-1'));
    push(completion('calc-1'));
    expect(useChatStore.getState().jobFeed).toHaveLength(1);
  });

  it('a redelivered completion keeps its original position and time', () => {
    // Now that the feed is persisted this is the difference between a stable list and one that
    // reshuffles on every reconnect: a filter-then-unshift would put a three-day-old card back at
    // the top, above completions that genuinely arrived since, and restamp it as new.
    push(completion('calc-old'));
    const original = useChatStore.getState().jobFeed[0]?.receivedAt ?? 0;
    push(completion('qm-new'));

    push(completion('calc-old'));

    const feed = useChatStore.getState().jobFeed;
    expect(feed.map((j) => j.event.job_id)).toEqual(['qm-new', 'calc-old']);
    expect(feed[1]?.receivedAt).toBe(original);
  });

  it('a redelivered completion does not un-see or un-dismiss itself', () => {
    // Otherwise the badge count climbs again on every reconnect for work already read, and a
    // dismissed card comes back.
    push(completion('calc-1'));
    useChatStore.getState().dismissJobItem('calc-1');

    push(completion('calc-1'));

    expect(useChatStore.getState().jobFeed[0]?.dismissed).toBe(true);
    expect(useChatStore.getState().jobFeed[0]?.seen).toBe(true);
  });

  it('dismisses only the named job', () => {
    push(completion('calc-1'));
    push(completion('calc-2'));
    useChatStore.getState().dismissJobItem('calc-1');
    // Dismissal is a flag now, not a delete: the feed is durable, so destroying the only copy on
    // one click would be unrecoverable.
    expect(
      useChatStore
        .getState()
        .jobFeed.filter((j) => !j.dismissed)
        .map((j) => j.event.job_id),
    ).toEqual(['calc-2']);
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

  it('shows a failed job as failed, with the reason the service gave', () => {
    // The whole point of the `job_failed` fix: before it, this event was dropped in
    // `normalizeEvent` and the chemist waited on a job that had already died.
    push(failure('qm-dead', 'the SCF did not converge in 200 cycles'));
    renderFeed();
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.getByText('the SCF did not converge in 200 cycles')).toBeTruthy();
  });

  it('an empty reason still reads as a failure rather than as a blank card', () => {
    // `reason` is documented as possibly empty. Saying nothing there would leave a card whose
    // only content is a job id, which is indistinguishable from a success at a glance.
    push(failure('qm-quiet', ''));
    renderFeed();
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.getByText(/is not still running/)).toBeTruthy();
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

  it('offers Open report on a report job and focuses that artefact in the pane (G1)', async () => {
    const { useExhibitPane } = await import('../src/state/exhibitPane.ts');
    useExhibitPane.setState({ open: false, sheetOpen: false, focus: {} });
    useChatStore.setState({
      conversations: {
        'c-report': {
          ...useChatStore.getState().conversations['c-report'],
          id: 'c-report',
          sessionId: SID,
          title: 'Process report',
        } as never,
      },
      activeId: 'c-report',
    });
    useChatStore.getState().pushJobFinished(
      {
        type: 'job_completed',
        job_id: 'report-1',
        summary: { note_id: 'report-amination', exhibit_id: 'xb-00aa11bb22cc33dd' },
      },
      SID,
    );
    renderFeed();
    fireEvent.click(screen.getByRole('button', { name: 'Open report' }));
    const pane = useExhibitPane.getState();
    expect(pane.open).toBe(true);
    expect(pane.focus[SID]).toEqual({ exhibitId: 'xb-00aa11bb22cc33dd', revision: 0 });
  });

  it('offers no Open report when the summary names no artefact, or one this service never minted', () => {
    push(completion('qm-1'));
    push(completion('qm-2', { exhibit_id: 'not-an-artefact' }));
    renderFeed();
    expect(screen.queryByRole('button', { name: 'Open report' })).toBeNull();
  });

  it('keeps Open report across a reload: the reconciled card asks the registry with its session', async () => {
    // A reload loses the stream's frame; the new page's leader asks `GET /jobs/{id}`. The service
    // keeps `exhibit_id` only when the request names the run's origin session (the contract's
    // wave-2 amendment), so the reconciled card has its Open report only if this client asks so.
    const { reconcileAfterTakeover } = await import('../src/state/jobReconcile.ts');
    const { stubFetch } = await import('./helpers.ts');
    const { useExhibitPane } = await import('../src/state/exhibitPane.ts');
    useExhibitPane.setState({ open: false, sheetOpen: false, focus: {} });
    const conversation = {
      id: 'c-report',
      sessionId: SID,
      title: 'Process report',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      contextLost: false,
      sessionOrigin: 'local',
      messages: [
        { id: 'u', role: 'user', text: 'write the report', at: Date.now() },
        {
          id: 'a',
          role: 'assistant',
          text: '',
          status: 'done',
          at: Date.now(),
          trace: [
            { id: 't', at: Date.now() - 1000, kind: 'job_started', job: { jobId: 'report-9' } },
          ],
        },
      ],
    };
    useChatStore.setState({
      conversations: { 'c-report': conversation as never },
      order: ['c-report'],
      activeId: 'c-report',
    });
    const stub = stubFetch((url) =>
      url.includes('session_id=')
        ? new Response(
            JSON.stringify({
              job_id: 'report-9',
              status: 'completed',
              summary: null,
              result: { note_id: 'report-amination', exhibit_id: 'xb-00aa11bb22cc33dd' },
              calc_refs: [],
              rationale: '',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        : // Without the session the service strips the pointer — the card the bug produced.
          new Response(
            JSON.stringify({
              job_id: 'report-9',
              status: 'completed',
              summary: null,
              result: { note_id: 'report-amination' },
              calc_refs: [],
              rationale: '',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
    );
    try {
      const published = await reconcileAfterTakeover(
        {
          id: 'tab-reloaded',
          isLeader: () => true,
          declare: () => undefined,
          watched: () => [],
          subscribe: () => () => undefined,
          publish: (note) => {
            if (note.kind === 'job')
              useChatStore.getState().pushJobFinished(note.event, note.sessionId);
          },
          close: () => undefined,
        },
        useChatStore.getState(),
        async () => null,
      );
      expect(published).toBe(1);
      expect(stub.calls[0]!.url).toBe(`/api/jobs/report-9?session_id=${SID}`);
    } finally {
      stub.restore();
    }
    renderFeed();
    fireEvent.click(screen.getByRole('button', { name: 'Open report' }));
    expect(useExhibitPane.getState().focus[SID]).toEqual({
      exhibitId: 'xb-00aa11bb22cc33dd',
      revision: 0,
    });
  });
});
