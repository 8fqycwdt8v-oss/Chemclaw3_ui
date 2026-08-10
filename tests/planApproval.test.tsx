/**
 * The plan gate is answered on the route that records it.
 *
 * The Approve button on a plan-approval card used to send the chat message "Approved — go ahead."
 * and nothing else. That records nothing and binds nothing: the agent read a sentence and decided
 * for itself, under the asking chemist's identity — the exact collapse of the GxP line that
 * `POST /sessions/{id}/plan/decision` exists to prevent.
 *
 * What is pinned here is the binding, not the button. The hash posted back must be the hash of
 * the plan the human was shown, which is why it is read when the card appears rather than when a
 * button is pressed; and a 409 must re-read the plan rather than approve whatever is current now.
 *
 * Deciding now takes two clicks: the card's button opens a confirmation, and the dialog's button
 * commits. That is deliberate — the decision is irreversible and attributable, and a single tap
 * was one mis-aimed thumb away from approving work nobody read. The tests go through the dialog
 * rather than around it, because the dialog is part of the contract now.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApprovalPrompt } from '../src/components/Prompts.tsx';
import { api } from '../src/api/client.ts';
import { ApiError } from '../src/api/errors.ts';

/**
 * `ready` is part of this contract, not scenery. The shell renders before auth resolves, against
 * a placeholder whose `getAccessToken` throws by design — so a card that reads the plan without
 * waiting for `ready` gets that throw and, before the gate below existed, read it as "this
 * service has no plan route" and stood the unbound conversational fallback up in its place.
 */
const authState = { ready: true, throws: false };

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({
    ready: authState.ready,
    auth: {
      getAccessToken: async () => {
        if (authState.throws) throw new Error('auth is not ready yet');
        return 'token';
      },
    },
  }),
}));

const SID = 'b'.repeat(32);

/** Open the named decision's confirmation and commit it. */
async function decideVia(triggerName: RegExp): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: triggerName }));
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: triggerName }));
}

const planStatus = (hash: string, plan: string[] = ['Run xTB on the aryl bromide']) => ({
  session_id: SID,
  plan_hash: hash,
  plan,
  mode: 'plan_only',
  approved: false,
  decided_by: null,
});

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  authState.ready = true;
  authState.throws = false;
});

describe('plan approval', () => {
  it('reads the plan when the card appears, and shows it', async () => {
    vi.spyOn(api, 'getPlan').mockResolvedValue(planStatus('h1'));
    render(<ApprovalPrompt prompt="Approve this plan?" approvalId="" sessionId={SID} />);

    expect(await screen.findByText('Run xTB on the aryl bromide')).toBeTruthy();
  });

  it('posts the hash of the plan that was shown', async () => {
    vi.spyOn(api, 'getPlan').mockResolvedValue(planStatus('h1'));
    const decide = vi.spyOn(api, 'decidePlan').mockResolvedValue();
    render(<ApprovalPrompt prompt="Approve this plan?" approvalId="" sessionId={SID} />);

    await decideVia(/approve plan/i);

    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(decide.mock.calls[0]?.slice(0, 3)).toEqual([SID, true, 'h1']);
  });

  it('sends a rejection on the same route rather than as a chat message', async () => {
    vi.spyOn(api, 'getPlan').mockResolvedValue(planStatus('h1'));
    const decide = vi.spyOn(api, 'decidePlan').mockResolvedValue();
    render(<ApprovalPrompt prompt="Approve this plan?" approvalId="" sessionId={SID} />);

    await decideVia(/decline/i);

    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(decide.mock.calls[0]?.[1]).toBe(false);
  });

  it('re-reads the plan when the service says it changed', async () => {
    // A 409 means the human agreed to something else. Re-fetching the hash and retrying would
    // make the binding decorative, so the card shows the new plan and asks again.
    const getPlan = vi
      .spyOn(api, 'getPlan')
      .mockResolvedValueOnce(planStatus('h1'))
      .mockResolvedValueOnce(planStatus('h2', ['Run DFT on the aryl bromide']));
    vi.spyOn(api, 'decidePlan').mockRejectedValue(
      new ApiError('plan_changed', 'the plan changed since it was shown', 409),
    );
    render(<ApprovalPrompt prompt="Approve this plan?" approvalId="" sessionId={SID} />);

    await decideVia(/approve plan/i);

    expect(await screen.findByText('Run DFT on the aryl bromide')).toBeTruthy();
    expect(getPlan).toHaveBeenCalledTimes(2);
  });

  it('falls back to the composer when the service has no plan route', async () => {
    // Better than a card whose only buttons do nothing — and the wording says which it is.
    vi.spyOn(api, 'getPlan').mockRejectedValue(new ApiError('session_not_found', 'nope', 404));
    render(<ApprovalPrompt prompt="Approve this plan?" approvalId="" sessionId={SID} />);

    expect(await screen.findByText(/cannot record a plan decision/)).toBeTruthy();
  });

  it('does not touch the plan route for a durable interaction hold', async () => {
    // The two cases share a card and nothing else: a hold is answered by its own id.
    const getPlan = vi.spyOn(api, 'getPlan');
    const decideApproval = vi.spyOn(api, 'decideApproval').mockResolvedValue();
    render(<ApprovalPrompt prompt="Save this note?" approvalId="approval-q-42" sessionId={SID} />);

    await decideVia(/^approve$/i);

    await waitFor(() => expect(decideApproval).toHaveBeenCalled());
    expect(getPlan).not.toHaveBeenCalled();
  });
});

describe('the plan gate does not downgrade itself', () => {
  it('waits for auth instead of reading the placeholder provider as a missing route', async () => {
    // The card mounts in the first commit after a page load, before auth resolves.
    authState.ready = false;
    authState.throws = true;
    const getPlan = vi.spyOn(api, 'getPlan').mockResolvedValue(planStatus('h1'));

    render(<ApprovalPrompt prompt="Approve this plan?" approvalId="" sessionId={SID} />);

    // It must not have asked, and must not have concluded the route is absent.
    await waitFor(() => expect(screen.queryByText(/Reading the plan/)).toBeTruthy());
    expect(getPlan).not.toHaveBeenCalled();
    expect(screen.queryByText(/cannot record a plan decision/)).toBeNull();
  });

  it('reads the plan once auth becomes ready', async () => {
    vi.spyOn(api, 'getPlan').mockResolvedValue(planStatus('h1'));
    authState.ready = false;
    authState.throws = true;
    const { rerender } = render(
      <ApprovalPrompt prompt="Approve this plan?" approvalId="" sessionId={SID} />,
    );

    authState.ready = true;
    authState.throws = false;
    rerender(<ApprovalPrompt prompt="Approve this plan?" approvalId="" sessionId={SID} />);

    expect(await screen.findByText('Run xTB on the aryl bromide')).toBeTruthy();
  });

  it('offers a retry, not the unbound fallback, when the plan read fails transiently', async () => {
    // A 500 is not "this service predates the plan route". Answering it in the conversation would
    // trade an attributable sign-off for an unattributable one over a blip.
    vi.spyOn(api, 'getPlan').mockRejectedValue(new ApiError('network', 'upstream unavailable'));

    render(<ApprovalPrompt prompt="Approve this plan?" approvalId="" sessionId={SID} />);

    expect(await screen.findByRole('button', { name: /Try again/ })).toBeTruthy();
    expect(screen.queryByText(/cannot record a plan decision/)).toBeNull();
  });

  it('still falls back to the composer when the route is genuinely absent', async () => {
    vi.spyOn(api, 'getPlan').mockRejectedValue(new ApiError('session_not_found', 'not found', 404));

    render(<ApprovalPrompt prompt="Approve this plan?" approvalId="" sessionId={SID} />);

    expect(await screen.findByText(/cannot record a plan decision/)).toBeTruthy();
  });
});
