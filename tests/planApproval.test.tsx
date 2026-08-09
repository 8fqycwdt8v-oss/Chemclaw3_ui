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
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApprovalPrompt } from '../src/components/Prompts.tsx';
import { api } from '../src/api/client.ts';
import { ApiError } from '../src/api/errors.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => 'token' } }),
}));

const SID = 'b'.repeat(32);

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

    fireEvent.click(await screen.findByText('Approve plan'));

    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(decide.mock.calls[0]?.slice(0, 3)).toEqual([SID, true, 'h1']);
  });

  it('sends a rejection on the same route rather than as a chat message', async () => {
    vi.spyOn(api, 'getPlan').mockResolvedValue(planStatus('h1'));
    const decide = vi.spyOn(api, 'decidePlan').mockResolvedValue();
    render(<ApprovalPrompt prompt="Approve this plan?" approvalId="" sessionId={SID} />);

    fireEvent.click(await screen.findByText('Decline'));

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

    fireEvent.click(await screen.findByText('Approve plan'));

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

    fireEvent.click(screen.getByText('Approve'));

    await waitFor(() => expect(decideApproval).toHaveBeenCalled());
    expect(getPlan).not.toHaveBeenCalled();
  });
});

/**
 * The fallback is for a service without the route, and for nothing else.
 *
 * The bug: every failure from `GET /sessions/{id}/plan` was swallowed into `unavailable`, whose
 * fallback lets one tap send "Approved — go ahead." with no `plan_approvals` row behind it. So an
 * expired token or a network blip silently downgraded a GxP gate to an unaudited path — and
 * rendered it as an ordinary Approve/Decline pair while doing so. These fail against that version.
 */
describe('when the plan cannot be read', () => {
  const cases: [string, ApiError][] = [
    ['an expired token', new ApiError('unauthorized', 'Your session has expired.', 401)],
    ['a missing role', new ApiError('forbidden', 'needs a role', 403)],
    [
      'a restarting pod',
      new ApiError('network', 'The service returned an unexpected status (502).', 502),
    ],
    ['a service at capacity', new ApiError('capacity', 'at capacity', 503)],
    ['a timeout', new ApiError('network', 'The Chemclaw service did not respond in time.')],
  ];

  it.each(cases)('offers no unrecorded shortcut after %s', async (_label, err) => {
    vi.spyOn(api, 'getPlan').mockRejectedValue(err);
    render(<ApprovalPrompt prompt="Approve this plan?" approvalId="" sessionId={SID} />);

    expect(await screen.findByText(/could not be read/i)).toBeTruthy();
    // The dangerous affordance must be absent entirely, not merely styled differently.
    expect(screen.queryByText(/Answer in the conversation anyway/)).toBeNull();
    expect(screen.queryByText(/cannot record a plan decision/)).toBeNull();
    // No button of any kind that sends a decision — recorded or otherwise. Matched by role, since
    // the card's own "Approval requested." heading is a paragraph and would match on text alone.
    for (const button of screen.queryAllByRole('button')) {
      expect(button.textContent).toBe('Try again');
    }
  });

  it('says what went wrong rather than only that something did', async () => {
    vi.spyOn(api, 'getPlan').mockRejectedValue(
      new ApiError('unauthorized', 'Your session has expired. Please sign in again.', 401),
    );
    render(<ApprovalPrompt prompt="Approve this plan?" approvalId="" sessionId={SID} />);

    expect(await screen.findByText(/Your session has expired/)).toBeTruthy();
  });

  it('retries the read rather than leaving a dead card', async () => {
    const getPlan = vi
      .spyOn(api, 'getPlan')
      .mockRejectedValueOnce(new ApiError('capacity', 'at capacity', 503))
      .mockResolvedValueOnce(planStatus('h1'));
    render(<ApprovalPrompt prompt="Approve this plan?" approvalId="" sessionId={SID} />);

    fireEvent.click(await screen.findByText('Try again'));

    expect(await screen.findByText('Run xTB on the aryl bromide')).toBeTruthy();
    expect(getPlan).toHaveBeenCalledTimes(2);
  });
});

describe('the unrecorded fallback', () => {
  const withNoRoute = async () => {
    vi.spyOn(api, 'getPlan').mockRejectedValue(new ApiError('session_not_found', 'nope', 404));
    render(<ApprovalPrompt prompt="Approve this plan?" approvalId="" sessionId={SID} />);
    return screen.findByText(/cannot record a plan decision/);
  };

  it('is not reachable in one tap', async () => {
    await withNoRoute();
    // The whole hazard was a button that looked like the recorded one and was not.
    expect(screen.queryByText('Approve')).toBeNull();
    expect(screen.queryByText('Approve plan')).toBeNull();
    expect(screen.getByText(/Answer in the conversation anyway/)).toBeTruthy();
  });

  it('says plainly that nothing will be recorded', async () => {
    await withNoRoute();
    expect(screen.getByText(/no approval is written/)).toBeTruthy();
    expect(screen.getByText(/audit trail/)).toBeTruthy();
  });

  it('labels the buttons as unrecorded once the chemist accepts', async () => {
    await withNoRoute();
    fireEvent.click(screen.getByText(/Answer in the conversation anyway/));

    expect(screen.getByText('Unrecorded — answered as a message')).toBeTruthy();
    expect(screen.getByText('Approve (not recorded)')).toBeTruthy();
    expect(screen.getByText('Decline (not recorded)')).toBeTruthy();
  });

  it('still sends the message once accepted, so the card is not a dead end', async () => {
    const sent: unknown[] = [];
    window.addEventListener('chemclaw:prefill', (e) => sent.push((e as CustomEvent).detail));
    await withNoRoute();
    fireEvent.click(screen.getByText(/Answer in the conversation anyway/));
    fireEvent.click(screen.getByText('Approve (not recorded)'));

    expect(sent).toEqual([{ text: 'Approved — go ahead.', autoSend: true }]);
  });
});
