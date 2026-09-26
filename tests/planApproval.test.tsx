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
  scope: string[] = ['compute_pka', 'record_knowledge_note'],
): PlanStatus => ({
  session_id: SID,
  plan_hash: hash,
  plan,
  scope,
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

  it('re-reads the scope with the steps when the service says it changed', async () => {
    // The buttons re-bind to the new revision after a 409, so the line naming what an approval
    // authorises must move with them — or a chemist approves write tools they were never shown.
    vi.spyOn(api, 'getPlan')
      .mockResolvedValueOnce(planStatus('h1', ['Run xTB on the aryl bromide'], ['compute_pka']))
      .mockResolvedValueOnce(
        planStatus('h2', ['Search conformers of the aryl bromide'], ['record_failure']),
      );
    vi.spyOn(api, 'decidePlan').mockRejectedValue(
      new ApiError('plan_changed', 'the plan changed since it was shown', 409),
    );
    render(<ApprovalPrompt prompt="Approve this plan?" sessionId={SID} />);

    expect(await screen.findByText(/compute_pka/)).toBeTruthy();
    await decideVia(/approve plan/i);

    expect(await screen.findByText(/record_failure/)).toBeTruthy();
    expect(screen.queryByText(/compute_pka/)).toBeNull();
  });

  it('keeps the re-read scope when the mount read resolves after it', async () => {
    // The mount read and the 409 re-read race, and nothing about a 409 changes the effect's
    // dependencies — so a mount read of H1 landing after the re-read of H2 used to stamp the scope
    // with H1. The card then showed H2's steps and live buttons with no line naming what
    // approving them authorises, on exactly the revision that added a write tool.
    let resolveMount: (status: PlanStatus) => void = () => undefined;
    vi.spyOn(api, 'getPlan')
      .mockImplementationOnce(
        () =>
          new Promise<PlanStatus>((resolve) => {
            resolveMount = resolve;
          }),
      )
      .mockResolvedValueOnce(
        planStatus('h2', ['Search conformers of the aryl bromide'], ['record_failure']),
      );
    vi.spyOn(api, 'decidePlan').mockRejectedValue(
      new ApiError('plan_changed', 'the plan changed since it was shown', 409),
    );
    render(
      <ApprovalPrompt
        prompt="Approve this plan?"
        sessionId={SID}
        planTodos={['Run xTB on the aryl bromide']}
        planHash="h1"
        planScope={null}
      />,
    );

    await decideVia(/approve plan/i);
    expect(await screen.findByText(/record_failure/)).toBeTruthy();

    resolveMount(planStatus('h1', ['Run xTB on the aryl bromide'], ['compute_pka']));
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByText('Search conformers of the aryl bromide')).toBeTruthy();
    expect(screen.getByText(/record_failure/)).toBeTruthy();
    expect(screen.queryByText(/compute_pka/)).toBeNull();
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
    // The steps came off the stream: the read this card makes is for the scope, and nothing it
    // answers is allowed to re-render a step. `PlanItems` is fed the streamed list either way.
    expect(getPlan).toHaveBeenCalledTimes(1);
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
  it('binds to the streamed hash, and never to what a read answered', async () => {
    // The service puts `plan_hash` on the `plan` event precisely so a client does not have to ask
    // again for the *binding* — and the ask is not merely a round trip, it races the revision the
    // hash exists to catch: between rendering the plan and reading its identity the agent may
    // revise it, and the read answers with what is current rather than with what this card is
    // showing. So what this pins is the binding rather than the absence of a read: the scope below
    // needs one, and the hash it posts still comes from the stream.
    const getPlan = vi.spyOn(api, 'getPlan').mockResolvedValue(planStatus('a-newer-hash'));
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
    expect(getPlan).toHaveBeenCalledTimes(1);
  });

  it('names the tools an approval authorises, which the steps do not say', async () => {
    // `D-2026-09-12-an-approval-that-names-no-tool-authorizes-every-tool` §3: "a surface that
    // rendered the steps alone would be collecting a yes to something it had not displayed". The
    // gate enforces the scope — a state-changing tool no step declared is refused even under a live
    // approval — so the scope is the half of the plan a person is deciding about that the steps do
    // not state, and it is only on the plan *route*.
    vi.spyOn(api, 'getPlan').mockResolvedValue(planStatus('streamed-hash'));
    render(
      <ApprovalPrompt
        prompt="Approve this plan?"
        sessionId={SID}
        planTodos={['Run xTB on the aryl bromide']}
        planHash="streamed-hash"
      />,
    );

    expect(await screen.findByText(/compute_pka/)).toBeTruthy();
    expect(screen.getByText(/record_knowledge_note/)).toBeTruthy();
  });

  it('shows no scope read off a plan it is not displaying', async () => {
    // The race the streamed hash exists to catch, applied to the scope: if the service has moved on
    // to another revision, its tool list is that revision's. Naming those tools over these steps
    // would be the disclosure defect inverted — a scope the approval does not authorise.
    vi.spyOn(api, 'getPlan').mockResolvedValue(
      planStatus('a-newer-hash', ['Something else entirely'], ['delete_everything']),
    );
    render(
      <ApprovalPrompt
        prompt="Approve this plan?"
        sessionId={SID}
        planTodos={['Run xTB on the aryl bromide']}
        planHash="streamed-hash"
      />,
    );

    expect(await screen.findByText('Run xTB on the aryl bromide')).toBeTruthy();
    expect(screen.queryByText(/delete_everything/)).toBeNull();
  });

  it('says nothing about scope against a service that sends none', async () => {
    // An older service has no `scope` on the plan route at all, which must read as "unknown" and
    // never as "this authorises nothing".
    vi.spyOn(api, 'getPlan').mockResolvedValue({
      ...planStatus('streamed-hash'),
      scope: undefined as unknown as string[],
    });
    render(
      <ApprovalPrompt
        prompt="Approve this plan?"
        sessionId={SID}
        planTodos={['Run xTB on the aryl bromide']}
        planHash="streamed-hash"
      />,
    );

    expect(await screen.findByText('Run xTB on the aryl bromide')).toBeTruthy();
    expect(screen.queryByText(/authorises/)).toBeNull();
  });

  it('lets a streamed revision replace a scope it had to fetch for an earlier one', async () => {
    // Revision 1 streamed an empty scope, which is stored as "unknown" and read off the route as
    // []. Revision 2 streams its own scope; the fetched [] describes revision 1 and must not win.
    vi.spyOn(api, 'getPlan').mockResolvedValue(planStatus('rev-1', ['Run xTB'], []));
    const { rerender } = render(
      <ApprovalPrompt
        prompt="Approve this plan?"
        sessionId={SID}
        planTodos={['Run xTB']}
        planHash="rev-1"
        planScope={null}
      />,
    );
    expect(await screen.findByText(/no tools beyond the read-only ones/)).toBeTruthy();

    rerender(
      <ApprovalPrompt
        prompt="Approve this plan?"
        sessionId={SID}
        planTodos={['Run xTB', 'Record the failure']}
        planHash="rev-2"
        planScope={['record_failure']}
      />,
    );

    expect(await screen.findByText(/record_failure/)).toBeTruthy();
    expect(screen.queryByText(/no tools beyond the read-only ones/)).toBeNull();
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
