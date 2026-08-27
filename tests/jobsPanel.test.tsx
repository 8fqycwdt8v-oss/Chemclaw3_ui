/**
 * The durable-run registry, and the honesty of its one destructive control.
 *
 * Two things are worth pinning here and neither is the list.
 *
 * **The rationale is the product.** `job_records` keeps why each run was launched, and that is
 * what makes a six-week-old calculation findable at all — a job id tells a reader nothing. The
 * search covers it, so the empty state has to say so, or a chemist searching for a *result* reads
 * "no run matches that" as "we never ran it".
 *
 * **Cancellation is a request, not an outcome.** The service answers 202 and a workflow already
 * past its last cancellation point finishes anyway, so nothing in this UI may say the job stopped.
 *
 * **And a read that failed has to stop looking like a read that is still going.** The sheet set
 * `status` to `null` on the way in and, on failure, wrote only the notice — so its spinner's
 * `!status` guard stayed true for the life of the sheet. A chemist got an error string with a
 * spinner turning under it, permanently, and no way to retry: the only other control in the sheet
 * is the close button. Its three sibling sheets all guard their spinner on a failed state, which
 * is what makes this an oversight rather than a house style.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { JobsPanel } from '../src/components/JobsPanel.tsx';
import { stubFetch } from './helpers.ts';
import type { DurableJobStatus, JobRecordSummary } from '../src/api/client.ts';

const mode = { current: 'dev' as 'dev' | 'msal', roles: [] as string[] };

vi.mock('../src/auth/AuthContext.tsx', async () => {
  const { config } = await import('../src/env.ts');
  const auth = {
    getAccessToken: async () => null,
    get mode() {
      return mode.current;
    },
    get account() {
      return { id: 'u', username: 'u', name: 'u', roles: mode.roles };
    },
  };
  const value = { auth, ready: true, revision: 0 };
  return {
    useAuth: () => value,
    useIsReviewer: () =>
      mode.current === 'dev' || config.reviewerRoles.some((r) => mode.roles.includes(r)),
  };
});

/**
 * Annotated with the interface the service's route is declared to return, not left as a bare
 * literal. Zero runtime cost, and it makes `tsc -b` — already a CI step — the drift check: a field
 * renamed or added on `JobRecordSummary` now fails the typecheck here instead of leaving this
 * fixture describing a shape the real service stopped sending. `e2e/fixture-service.ts`'s own
 * comment records that exact failure having happened once, to `GET /sessions`.
 */
const RECORD: JobRecordSummary = {
  job_id: 'calc-9f2c',
  connector: 'calc',
  job: 'compare_solvents',
  rationale: 'Decide whether 2-MeTHF or CPME favours the coupling.',
  summary: '4 solvents ranked by ΔG.',
  note_id: '',
  completed_at: '2026-08-01T09:00:00Z',
};

const STATUS: DurableJobStatus = {
  job_id: 'calc-9f2c',
  status: 'running',
  summary: null,
  result: {},
  rationale: RECORD.rationale,
};

let restore: (() => void) | null = null;
const deletes: string[] = [];
let searched = '';

/** How many times the job read has been asked for, and whether it is currently failing. */
let jobReads = 0;
let jobReadFails = false;

function serve(records = [RECORD]): void {
  const stub = stubFetch((url, init) => {
    if (init?.method === 'DELETE') {
      deletes.push(url);
      // 202 with a body, as the service answers — cancellation is accepted, not performed.
      return new Response(JSON.stringify({ status: 'cancelling', job_id: 'calc-9f2c' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/jobs/')) {
      jobReads += 1;
      if (jobReadFails) {
        return new Response(JSON.stringify({ detail: 'boom' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(STATUS), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    searched = new URL(url, 'http://x').searchParams.get('text') ?? '';
    return new Response(JSON.stringify(searched ? [] : records), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  restore = stub.restore;
}

beforeEach(() => {
  cleanup();
  deletes.length = 0;
  searched = '';
  jobReads = 0;
  jobReadFails = false;
  mode.current = 'dev';
  mode.roles = [];
});
afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

describe('JobsPanel', () => {
  it('leads with why a run happened, not with its id', async () => {
    serve();
    render(<JobsPanel />);

    expect(
      await screen.findByText('Decide whether 2-MeTHF or CPME favours the coupling.'),
    ).toBeTruthy();
    expect(screen.getByText('compare_solvents')).toBeTruthy();
  });

  it('searches the rationale, and says that is what it searched', async () => {
    // Otherwise a chemist searching for a result reads "no run matches that" as "we never ran it".
    serve();
    render(<JobsPanel />);
    await screen.findByText('compare_solvents');

    fireEvent.change(screen.getByLabelText('Search runs'), { target: { value: 'nitration' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => expect(searched).toBe('nitration'));
    expect(await screen.findByText(/No run matches that/)).toBeTruthy();
    expect(screen.getByText(/rationale recorded when each run was launched/)).toBeTruthy();
  });

  it('asks for cancellation without claiming the job stopped', async () => {
    serve();
    render(<JobsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /compare_solvents/ }));
    await screen.findByText('running');

    fireEvent.click(screen.getByRole('button', { name: 'Request cancellation' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request cancellation' }));

    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0]).toContain('/jobs/calc-9f2c');
    // The wording the service's 202 actually supports.
    expect(await screen.findByText(/will still finish/)).toBeTruthy();
  });

  it('does not offer cancellation to someone without the role', async () => {
    mode.current = 'msal';
    mode.roles = [];
    serve();
    render(<JobsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /compare_solvents/ }));
    await screen.findByText('running');

    expect(screen.queryByRole('button', { name: 'Request cancellation' })).toBeNull();
    expect(screen.getByText(/needs a reviewer role/)).toBeTruthy();
  });

  it('stops the spinner when the read failed, and offers the retry', async () => {
    // Otherwise "still loading" and "this failed and will never load" are the same screen.
    jobReadFails = true;
    serve();
    render(<JobsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /compare_solvents/ }));

    await screen.findByRole('status');
    await waitFor(() => expect(screen.queryByText('Reading the job…')).toBeNull());

    jobReadFails = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('running')).toBeTruthy();
    expect(jobReads).toBe(2);
  });

  it('tells a multi-hour campaign apart from a calculation, in the list and in the sheet', async () => {
    // Every row here is a durable job, so "durable" separates none of them. A campaign is a *loop* —
    // it proposes, evaluates and repeats for as many rounds as its spec asked for — so it runs for
    // hours where a conformer search runs for minutes, and it rendered identically to one.
    const campaign: JobRecordSummary = {
      job_id: 'bo-7c31',
      connector: 'bo',
      job: 'start_optimization_campaign',
      rationale: 'Push the amination past 85% without losing selectivity.',
      summary: '12 rounds, best 88.1%.',
      note_id: 'bo-candidate-7c31',
      completed_at: null,
    };
    serve([campaign, RECORD]);
    render(<JobsPanel />);

    // The badge is in the list, where a reader is scanning rows.
    const row = await screen.findByRole('button', { name: /start_optimization_campaign/ });
    expect(within(row).getByText('campaign')).toBeTruthy();
    // And the calculation beside it does not get one, which is what makes the badge mean something.
    const calc = screen.getByRole('button', { name: /compare_solvents/ });
    expect(within(calc).queryByText('campaign')).toBeNull();

    // The sentence explaining what a campaign *is* belongs in the sheet: read once, rather than
    // repeated down every row of a search result.
    fireEvent.click(row);
    expect(await screen.findByText('optimisation campaign')).toBeTruthy();
    expect(screen.getByText(/hours rather than the minutes/)).toBeTruthy();
  });

  it('distinguishes an empty registry from an empty search', async () => {
    serve([]);
    render(<JobsPanel />);
    expect(await screen.findByText('No runs recorded yet')).toBeTruthy();
  });
});
