/**
 * The PR-gate's surface, where a rendering mistake is a governance mistake.
 *
 * Three properties are pinned, and each of them is a claim made on screen rather than a value in a
 * store:
 *
 *  - **A rejection cannot be submitted without a reason.** The service 422s an empty one because
 *    "why was this refused" is the question a rejected proposal exists to answer. A UI that let
 *    the click through would turn a policy into an error toast.
 *  - **The dependencies are shown.** `ProposalDetail.dependencies` is the rest of the submission,
 *    and a note plus the notes its links depend on is one reviewable unit. Rendering the subject
 *    note alone invites approving a link whose far end nobody saw — so the far end is on screen.
 *  - **A `compound` note's structure is drawn.** `compound_smiles` is the only typed structure
 *    field in these contracts; asking a reviewer to check a molecule by reading SMILES is asking
 *    them to do the one thing the renderer exists to spare them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReviewView } from '../src/views/ReviewView.tsx';
import { api, type ProposalDetail, type ProposalSummary } from '../src/api/client.ts';
import { ApiError } from '../src/api/errors.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => 'token' } }),
}));

const summary: ProposalSummary = {
  id: 41,
  note_id: 'compound-4-bromoanisole',
  note_type: 'compound',
  state: 'open',
  branch: 'note/compound-4-bromoanisole',
  reference: 'refs/heads/note/compound-4-bromoanisole',
  actor: 'chemist@example.com',
  submitted_at: '2026-08-01T09:00:00Z',
  decided_at: null,
  decided_by: '',
  reason: '',
};

const detail: ProposalDetail = {
  ...summary,
  content: `---
compound_smiles: COc1ccc(Br)cc1
id: compound-4-bromoanisole
type: compound
---

An electron-rich aryl bromide.
`,
  dependencies: [
    {
      path: 'knowledge/reaction/rxn-suzuki-biaryl.md',
      content: `---
id: rxn-suzuki-biaryl
type: reaction
---

Suzuki-Miyaura coupling.
`,
    },
  ],
  session_id: 'b'.repeat(32),
  correlation_id: 'corr-7',
};

const openProposal = async (): Promise<void> => {
  render(<ReviewView />);
  fireEvent.click(await screen.findByText('compound-4-bromoanisole'));
};

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.spyOn(api, 'listProposals').mockResolvedValue([summary]);
  vi.spyOn(api, 'getProposal').mockResolvedValue(detail);
});

describe('review queue', () => {
  it('refuses to submit a rejection with no reason', async () => {
    const decide = vi.spyOn(api, 'decideProposal').mockResolvedValue();
    await openProposal();

    const reject = await screen.findByText('Reject');
    expect((reject as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(reject);
    expect(decide).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Reason/), {
      target: { value: 'The SMILES is the wrong regiochemistry.' },
    });
    fireEvent.click(screen.getByText('Reject'));

    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(decide.mock.calls[0]?.slice(0, 3)).toEqual([
      41,
      false,
      'The SMILES is the wrong regiochemistry.',
    ]);
  });

  it('lets an approval through without one, because only a rejection requires it', async () => {
    const decide = vi.spyOn(api, 'decideProposal').mockResolvedValue();
    await openProposal();

    fireEvent.click(await screen.findByText('Approve'));

    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(decide.mock.calls[0]?.slice(0, 3)).toEqual([41, true, '']);
  });

  it('shows every file the submission would write, not only the subject note', async () => {
    await openProposal();

    expect(await screen.findByText('knowledge/reaction/rxn-suzuki-biaryl.md')).toBeTruthy();
    expect(screen.getByText('Suzuki-Miyaura coupling.')).toBeTruthy();
  });

  it('draws the proposed structure and keeps the raw bytes reachable', async () => {
    await openProposal();

    // The structure the reviewer is being asked to accept, drawn rather than spelled.
    expect(await screen.findByLabelText('Structure of COc1ccc(Br)cc1')).toBeTruthy();

    // …and the file itself, because what is signed off on is the bytes.
    fireEvent.click(screen.getAllByText('raw file')[0] as HTMLElement);
    expect(screen.getByText(/compound_smiles: COc1ccc\(Br\)cc1/)).toBeTruthy();
  });

  it('shows the audit handles a reviewer needs to trace the note back', async () => {
    await openProposal();

    expect(await screen.findByText('corr-7')).toBeTruthy();
    expect(screen.getByText('b'.repeat(32))).toBeTruthy();
  });

  it('does not render an unreadable queue as an empty one', async () => {
    vi.spyOn(api, 'listProposals').mockRejectedValue(
      new ApiError('network', 'upstream unavailable'),
    );
    render(<ReviewView />);

    expect(await screen.findByText('The review queue could not be read.')).toBeTruthy();
    expect(screen.queryByText('Nothing in this state.')).toBeNull();
  });
});
