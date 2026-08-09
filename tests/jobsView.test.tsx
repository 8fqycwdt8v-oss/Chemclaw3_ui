/**
 * The cancel action's honesty.
 *
 * `DELETE /jobs/{id}` has two semantics a UI can very easily misreport, and both are documented in
 * the backend route rather than inferable from the status code:
 *
 *  - **202 is not a stop.** Temporal's cancellation is cooperative; the request has been delivered
 *    and the workflow unwinds through its own teardown whenever it next can. A button that flips
 *    to "cancelled" on a 202 tells an operator watching a runaway DFT campaign that the cluster
 *    stopped burning money, which is a claim nobody has made.
 *  - **403 is the answer, not a failure.** `job_workflow_id` deliberately excludes the requester,
 *    so two chemists asking for the identical run share it and it has no owner; the backend gates
 *    the cancel on the reviewer role for that reason. Rendering it as a red error invites a retry
 *    that will never succeed.
 *
 * These are assertions about rendered text because that is where the claim is made. A store
 * assertion would happily pass while the screen said "cancelled".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { JobsView } from '../src/views/JobsView.tsx';
import { api } from '../src/api/client.ts';
import { ApiError } from '../src/api/errors.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => 'token' } }),
}));

const JOB_ID = 'qm-compute_dft_energy-0123456789abcdef';

const openJob = async (): Promise<void> => {
  render(<JobsView />);
  fireEvent.change(await screen.findByLabelText('Open a job by id'), {
    target: { value: JOB_ID },
  });
  fireEvent.click(screen.getByText('Open'));
};

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.spyOn(api, 'listJobs').mockResolvedValue([]);
});

describe('jobs view', () => {
  it('offers no cancel for a run that has already ended', async () => {
    vi.spyOn(api, 'getJob').mockResolvedValue({
      job_id: JOB_ID,
      status: 'completed',
      summary: 'converged in 41 cycles',
    });
    await openJob();

    expect(await screen.findByText('completed')).toBeTruthy();
    expect(screen.queryByText('Request cancellation')).toBeNull();
  });

  it('says a cancellation was requested, never that the run stopped', async () => {
    vi.spyOn(api, 'getJob').mockResolvedValue({ job_id: JOB_ID, status: 'running' });
    const cancel = vi
      .spyOn(api, 'requestJobCancel')
      .mockResolvedValue({ status: 'cancelling', job_id: JOB_ID });
    await openJob();

    fireEvent.click(await screen.findByText('Request cancellation'));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(JOB_ID, expect.any(Function)));

    expect(
      screen.getByText(/Cancellation requested — the run has not been confirmed stopped/),
    ).toBeTruthy();
    // The status pill still reads whatever the service last said, because nothing has re-read it.
    expect(screen.getByText('running')).toBeTruthy();
    expect(screen.queryByText(/^cancelled$/)).toBeNull();
  });

  it('re-reads the status rather than inferring the outcome from the 202', async () => {
    const getJob = vi
      .spyOn(api, 'getJob')
      .mockResolvedValueOnce({ job_id: JOB_ID, status: 'running' })
      .mockResolvedValue({ job_id: JOB_ID, status: 'cancelled' });
    vi.spyOn(api, 'requestJobCancel').mockResolvedValue({ status: 'cancelling', job_id: JOB_ID });
    await openJob();

    fireEvent.click(await screen.findByText('Request cancellation'));
    fireEvent.click(await screen.findByText('Re-read status'));

    // "cancelled" appears only once the service says so — which is the only thing that knows.
    expect(await screen.findByText('cancelled')).toBeTruthy();
    expect(getJob).toHaveBeenCalledTimes(2);
  });

  it('renders a 403 as the role it is about, not as a failure to retry', async () => {
    vi.spyOn(api, 'getJob').mockResolvedValue({ job_id: JOB_ID, status: 'running' });
    vi.spyOn(api, 'requestJobCancel').mockRejectedValue(
      new ApiError(
        'network',
        'cancelling a durable job is an operator action: the run may be shared by several ' +
          'requesters, so it needs a privileged role',
        403,
      ),
    );
    await openJob();

    fireEvent.click(await screen.findByText('Request cancellation'));

    expect(
      await screen.findByText('Cancelling a durable run needs an operator role.'),
    ).toBeTruthy();
    // The service's own sentence, which states the shared-run reason. Paraphrasing it here would
    // lose the only explanation of why ownership is not the rule.
    expect(screen.getByText(/the run may be shared by several requesters/)).toBeTruthy();
    expect(screen.queryByText('The cancel request did not reach the service.')).toBeNull();
  });

  it('does not report an unreadable job list as an empty one', async () => {
    vi.spyOn(api, 'listJobs').mockRejectedValue(new ApiError('network', 'upstream unavailable'));
    render(<JobsView />);

    expect(await screen.findByText('The job record could not be read.')).toBeTruthy();
    expect(screen.queryByText(/No finished runs recorded/)).toBeNull();
  });
});
