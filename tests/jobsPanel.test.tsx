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
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { JobsPanel } from '../src/components/JobsPanel.tsx';
import { stubFetch } from './helpers.ts';

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

const RECORD = {
  job_id: 'calc-9f2c',
  connector: 'calc',
  job: 'compare_solvents',
  rationale: 'Decide whether 2-MeTHF or CPME favours the coupling.',
  summary: '4 solvents ranked by ΔG.',
  note_id: '',
  completed_at: '2026-08-01T09:00:00Z',
};

const STATUS = {
  job_id: 'calc-9f2c',
  status: 'running',
  summary: null,
  result: {},
  rationale: RECORD.rationale,
};

let restore: (() => void) | null = null;
const deletes: string[] = [];
let searched = '';

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

  it('distinguishes an empty registry from an empty search', async () => {
    serve([]);
    render(<JobsPanel />);
    expect(await screen.findByText('No runs recorded yet')).toBeTruthy();
  });
});
