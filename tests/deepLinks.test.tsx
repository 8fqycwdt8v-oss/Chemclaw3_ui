/**
 * A row somebody can be sent to.
 *
 * The routes stopped at the list level: `/review`, `/jobs`, `/protocols/:designId`. So a reviewer
 * could not be sent to a proposal, an operator could not be sent to a run, and a QA reviewer asked
 * to look at what changed in revision 3 had nowhere to be sent at all — `api.getProtocol` has taken
 * a `revision` since it was written, and the address bar never carried it.
 *
 * The route file already makes this argument about the design id: it is in the URL "so a shared
 * link and a reload land on the same one". A proposal id, a job id and a revision number are the
 * same kind of thing, and all three appear in an answer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { JobsPanel } from '../src/components/JobsPanel.tsx';
import { ReviewQueue } from '../src/components/ReviewQueue.tsx';
import type { DurableJobStatus, JobRecordSummary, ProposalDetail } from '../src/api/client.ts';

vi.mock('../src/auth/AuthContext.tsx', () => {
  const value = { auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true };
  return { useAuth: () => value, useIsReviewer: () => true };
});

const RECORD: JobRecordSummary = {
  job_id: 'calc-9f2c',
  connector: 'calc',
  job: 'compare_solvents',
  rationale: 'Decide whether 2-MeTHF or CPME favours the coupling.',
  summary: '',
  note_id: '',
  completed_at: null,
};

const STATUS: DurableJobStatus = {
  job_id: 'calc-9f2c',
  status: 'running',
  summary: null,
  result: {},
  rationale: RECORD.rationale,
};

const DETAIL: ProposalDetail = {
  id: 7,
  note_id: 'note-suzuki-42',
  note_type: 'reaction',
  actor: 'agent',
  state: 'pending',
  content: 'the bytes that would be committed',
  dependencies: [],
  submitted_at: '2026-09-01T00:00:00Z',
  decided_at: '',
  decided_by: '',
  reason: '',
  session_id: '',
  correlation_id: '',
  branch: '',
  reference: '',
};

let restore: (() => void) | null = null;

function serve(): void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.includes('/jobs/')) return Promise.resolve(json(STATUS));
    if (url.includes('/jobs')) return Promise.resolve(json([RECORD]));
    if (url.includes('/proposals/7')) return Promise.resolve(json(DETAIL));
    if (url.includes('/proposals')) return Promise.resolve(json([]));
    if (url.includes('/plans/pending')) {
      return Promise.resolve(json({ plans: [], gated: false, unread: 0 }));
    }
    if (/\/pending$/.test(url)) return Promise.resolve(json({ requests: [], count: 0 }));
    return Promise.resolve(json([]));
  }) as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
}

/** Reports the path so a test can assert the URL moved with the sheet. */
function Where({ into }: { into: string[] }): null {
  const location = useLocation();
  into.push(location.pathname);
  return null;
}

beforeEach(() => {
  cleanup();
  serve();
});
afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

describe('a link to one run', () => {
  it('opens that run’s sheet without a click', async () => {
    render(
      <MemoryRouter initialEntries={['/jobs/calc-9f2c']}>
        <Routes>
          <Route path="/jobs" element={<JobsPanel />} />
          <Route path="/jobs/:jobId" element={<JobsPanel />} />
        </Routes>
      </MemoryRouter>,
    );

    // The sheet's own heading, not the list row — the list carries the job's *name*.
    expect(await screen.findByText('calc-9f2c')).toBeTruthy();
    expect(await screen.findByText('running')).toBeTruthy();
  });

  it('moves the URL when the sheet is closed', async () => {
    // Otherwise Back is the only way out of a route that reopens the sheet on every render.
    const seen: string[] = [];
    render(
      <MemoryRouter initialEntries={['/jobs/calc-9f2c']}>
        <Where into={seen} />
        <Routes>
          <Route path="/jobs" element={<JobsPanel />} />
          <Route path="/jobs/:jobId" element={<JobsPanel />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('running');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(seen[seen.length - 1]).toBe('/jobs'));
  });

  it('leaves the plain list closed', async () => {
    render(
      <MemoryRouter initialEntries={['/jobs']}>
        <Routes>
          <Route path="/jobs" element={<JobsPanel />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('compare_solvents');
    expect(screen.queryByText('running')).toBeNull();
  });
});

describe('a link to one proposal', () => {
  it('opens the bytes it would commit', async () => {
    render(
      <MemoryRouter initialEntries={['/review/7']}>
        <Routes>
          <Route path="/review" element={<ReviewQueue />} />
          <Route path="/review/:proposalId" element={<ReviewQueue />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('the bytes that would be committed')).toBeTruthy();
  });

  it('ignores a path segment that is not a proposal id', async () => {
    // The route pattern is `:proposalId`, so anything can arrive here. Every proposal route
    // downstream takes a number, and asking for `/proposals/NaN` is a request this app should not
    // be able to make.
    render(
      <MemoryRouter initialEntries={['/review/not-a-number']}>
        <Routes>
          <Route path="/review/:proposalId" element={<ReviewQueue />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('No notes are waiting for review');
    expect(screen.queryByText('the bytes that would be committed')).toBeNull();
  });
});
