/**
 * A row somebody can be sent to.
 *
 * The routes stopped at the list level: `/review`, `/jobs`, `/protocols/:designId`. So an operator
 * could not be sent to a run, and a QA reviewer asked to look at what changed in revision 3 had
 * nowhere to be sent at all — `api.getProtocol` has taken a `revision` since it was written, and
 * the address bar never carried it.
 *
 * The route file already makes this argument about the design id: it is in the URL "so a shared
 * link and a reload land on the same one". A job id and a revision number are the same kind of
 * thing, and both appear in an answer.
 *
 * A third case stood here — `/review/:proposalId` — and went with the PR-gate it addressed
 * (`D-2026-09-05-the-gate-follows-behaviour-not-knowledge` in Chemclaw3).
 */

import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import { JobsPanel } from '../src/components/JobsPanel.tsx';
import type { DurableJobStatus, JobRecordSummary } from '../src/api/client.ts';

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

/**
 * Hands the test the router's own `navigate`.
 *
 * A module-level binding rather than a prop this writes into, because an open sheet is a modal:
 * Radix marks everything outside it `aria-hidden`, so a link beside the routes is not reachable
 * and a location change has to be driven directly.
 */
let navigateTo: ((path: string) => void) | null = null;

function Navigator(): null {
  const navigate = useNavigate();
  useEffect(() => {
    navigateTo = (path) => void navigate(path);
    return () => {
      navigateTo = null;
    };
  }, [navigate]);
  return null;
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

  it('follows a SECOND link without a remount', async () => {
    // The half a deep link is only half of. React Router keeps `JobsPanel` mounted across
    // `/jobs/a` → `/jobs/b`, so a panel that seeded `useState` from the parameter read it exactly
    // once: every arm above passed while a second link — from another tab, from Back or Forward,
    // or from anywhere in the app — moved the address bar and left the first run's sheet on
    // screen. The URL is now the only thing that says what is open, and this is what says so.
    render(
      <MemoryRouter initialEntries={['/jobs/calc-9f2c']}>
        <Navigator />
        <Routes>
          <Route path="/jobs" element={<JobsPanel />} />
          <Route path="/jobs/:jobId" element={<JobsPanel />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('calc-9f2c')).toBeTruthy();

    // Driven through the router rather than by clicking a link on the page: the open sheet is a
    // modal, so Radix marks everything outside it `aria-hidden` and a link beside it is not
    // reachable. What is under test is the panel's reaction to the location changing, and this is
    // that, with no assumption about which affordance changed it.
    act(() => navigateTo?.('/jobs/calc-0001'));

    // Scoped to the sheet: `calc-9f2c` is also the id printed on the one list row behind it, so an
    // unscoped `queryByText` would be asserting about the list rather than about what is open.
    const sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByText('calc-0001')).toBeTruthy();
    expect(within(sheet).queryByText('calc-9f2c')).toBeNull();
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
