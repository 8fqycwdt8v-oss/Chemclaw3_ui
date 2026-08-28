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
 *
 * The card had a second case — a non-empty `approval_id` meaning a durable interaction hold — and
 * it is gone with the mechanism (`D-2026-08-27-a-hold-nothing-can-open-is-not-a-hold`): nothing
 * upstream could open a hold, so the branch was unreachable and its route 404s.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApprovalPrompt } from '../src/components/Prompts.tsx';
import { api } from '../src/api/client.ts';
import { ApiError } from '../src/api/errors.ts';
import type { PlanStatus } from '../src/api/client.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => 'token' } }),
}));

const SID = 'b'.repeat(32);

/** Open the named decision's confirmation and commit it. */
async function decideVia(triggerName: RegExp): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: triggerName }));
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: triggerName }));
}

const planStatus = (
  hash: string,
  plan: string[] = ['Run xTB on the aryl bromide'],
): PlanStatus => ({
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
    render(<ApprovalPrompt prompt="Approve this plan?" sessionId={SID} />);

    expect(await screen.findByText('Run xTB on the aryl bromide')).toBeTruthy();
  });

  it('posts the hash of the plan that was shown', async () => {
    vi.spyOn(api, 'getPlan').mockResolvedValue(planStatus('h1'));
    const decide = vi.spyOn(api, 'decidePlan').mockResolvedValue();
    render(<ApprovalPrompt prompt="Approve this plan?" sessionId={SID} />);

    await decideVia(/approve plan/i);

    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(decide.mock.calls[0]?.slice(0, 3)).toEqual([SID, true, 'h1']);
  });

  it('sends a rejection on the same route rather than as a chat message', async () => {
    vi.spyOn(api, 'getPlan').mockResolvedValue(planStatus('h1'));
    const decide = vi.spyOn(api, 'decidePlan').mockResolvedValue();
    render(<ApprovalPrompt prompt="Approve this plan?" sessionId={SID} />);

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
      .mockResolvedValueOnce(planStatus('h2', ['Search conformers of the aryl bromide']));
    vi.spyOn(api, 'decidePlan').mockRejectedValue(
      new ApiError('plan_changed', 'the plan changed since it was shown', 409),
    );
    render(<ApprovalPrompt prompt="Approve this plan?" sessionId={SID} />);

    await decideVia(/approve plan/i);

    expect(await screen.findByText('Search conformers of the aryl bromide')).toBeTruthy();
    expect(getPlan).toHaveBeenCalledTimes(2);
  });

  it('falls back to the composer when the service has no plan route', async () => {
    // Better than a card whose only buttons do nothing — and the wording says which it is.
    vi.spyOn(api, 'getPlan').mockRejectedValue(new ApiError('session_not_found', 'nope', 404));
    render(<ApprovalPrompt prompt="Approve this plan?" sessionId={SID} />);

    expect(await screen.findByText(/cannot record a plan decision/)).toBeTruthy();
  });
});

describe('what approving actually did', () => {
  // "You approved this request. The agent will pick it up on its next run." was wrong twice over,
  // and both halves stranded a reader. Nothing runs when a decision is recorded — the approval is
  // a row, and the agent acts on the next *request*, which is something a person has to send — and
  // the approval is spent when that turn ends, so it covers one request rather than the rest of
  // the conversation. Someone who read it literally waited for work that was never going to start.
  it('says the approval covers one request, and offers the request', async () => {
    vi.spyOn(api, 'getPlan').mockResolvedValue(planStatus('h1'));
    vi.spyOn(api, 'decidePlan').mockResolvedValue();
    render(<ApprovalPrompt prompt="Approve this plan?" sessionId={SID} />);

    await decideVia(/approve plan/i);

    expect(await screen.findByText(/next request only/i)).toBeTruthy();
    expect(screen.getByText(/spent when that turn ends/i)).toBeTruthy();
    // And a way to send that request, so approving is not a dead end.
    expect(screen.getByRole('button', { name: /continue/i })).toBeTruthy();
    // The old sentence promised something would happen by itself. It must not be back.
    expect(screen.queryByText(/pick it up on its next run/i)).toBeNull();
  });

  it('leaves a decline final, with nothing to continue', async () => {
    vi.spyOn(api, 'getPlan').mockResolvedValue(planStatus('h1'));
    vi.spyOn(api, 'decidePlan').mockResolvedValue();
    render(<ApprovalPrompt prompt="Approve this plan?" sessionId={SID} />);

    await decideVia(/decline/i);

    expect(await screen.findByText(/nothing will run/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /continue/i })).toBeNull();
  });
});

describe('the plan the card shows', () => {
  // The service encodes each step's completion as a leading `[x] ` / `[ ] ` prefix on the line,
  // and `PlanItems` is the one component that knows to parse it off. This card rendered the plan
  // with a hand-rolled list instead, so the most consequential card in the product showed
  // `[ ] Run xTB…` as literal text while the checklist a few lines above it — same steps, same
  // event — rendered them as a proper checklist.
  it('parses the checkbox prefix off a streamed step instead of printing it', async () => {
    const getPlan = vi.spyOn(api, 'getPlan');
    render(
      <ApprovalPrompt
        prompt="Approve this plan?"
        sessionId={SID}
        planTodos={['[x] Check the hazard profile', '[ ] Run xTB on the aryl bromide']}
        planHash="h-streamed"
      />,
    );

    // The step text is there without its prefix...
    expect(await screen.findByText('Run xTB on the aryl bromide')).toBeTruthy();
    expect(screen.getByText('Check the hazard profile')).toBeTruthy();
    // ...and the prefix is not rendered anywhere as text.
    expect(screen.queryByText(/\[[x ]\]/)).toBeNull();
    // Completion state reaches a screen reader, not only the strikethrough.
    expect(screen.getByText('Done:')).toBeTruthy();
    expect(screen.getByText('To do:')).toBeTruthy();
    // Still no round trip: the stream carried both halves.
    expect(getPlan).not.toHaveBeenCalled();
  });

  // The fetch fallback returns bare step text with no status, and a checkbox drawn for it would
  // claim a completion state nobody reported. `PlanItems` renders those as plain bullets.
  it('renders an unprefixed fetched step without inventing a completion state', async () => {
    vi.spyOn(api, 'getPlan').mockResolvedValue(planStatus('h1', ['Estimate the pKa']));
    render(<ApprovalPrompt prompt="Approve this plan?" sessionId={SID} />);

    expect(await screen.findByText('Estimate the pKa')).toBeTruthy();
    expect(screen.queryByText('Done:')).toBeNull();
    expect(screen.queryByText('To do:')).toBeNull();
  });
});

describe('the plan the stream already carried', () => {
  it('binds to the streamed hash without a second read', async () => {
    // The service puts `plan_hash` on the `plan` event precisely so a client does not have to ask
    // again — and the ask is not merely a round trip, it races the revision the hash exists to
    // catch: between rendering the plan and fetching its identity the agent may revise it, and the
    // fetch answers with what is current rather than with what this card is showing.
    const getPlan = vi.spyOn(api, 'getPlan');
    const decide = vi.spyOn(api, 'decidePlan').mockResolvedValue();
    render(
      <ApprovalPrompt
        prompt="Approve this plan?"
        sessionId={SID}
        planTodos={['Run xTB on the aryl bromide']}
        planHash="streamed-hash"
      />,
    );

    expect(await screen.findByText('Run xTB on the aryl bromide')).toBeTruthy();
    await decideVia(/approve/i);
    await waitFor(() =>
      expect(decide).toHaveBeenCalledWith(SID, true, 'streamed-hash', expect.anything()),
    );
    expect(getPlan).not.toHaveBeenCalled();
  });

  it('falls back to the fetch when the service sent no hash', async () => {
    // An older service defaults the field to '', which a client must read as "go and fetch it" and
    // never as a hash that will match. This is that path, unchanged.
    const getPlan = vi.spyOn(api, 'getPlan').mockResolvedValue(planStatus('h1'));
    render(
      <ApprovalPrompt
        prompt="Approve this plan?"
        sessionId={SID}
        planTodos={['Run xTB on the aryl bromide']}
        planHash=""
      />,
    );

    await waitFor(() => expect(getPlan).toHaveBeenCalled());
  });
});
