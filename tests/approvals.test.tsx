/**
 * The approvals inbox.
 *
 * A durable Yes/No hold authorizes a knowledge write and expires if nobody answers it. Until the
 * service grew `GET /approvals`, the only way to answer one was the card inside the turn that
 * raised it, so a hold outlived its answer whenever the chemist closed the tab or moved on — and
 * then timed out, silently dropping what it was holding. What these tests pin is the part that
 * makes the inbox trustworthy rather than merely present: the count is readable without opening
 * anything, a failed query is not rendered as an empty queue, and a decision still costs two
 * deliberate clicks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api } from '../src/api/client.ts';
import { AuthGate } from '../src/auth/AuthContext.tsx';
import { ApprovalsInbox } from '../src/components/ApprovalsInbox.tsx';

const HOLDS = [
  {
    approval_id: 'approval-int-1',
    question: 'Record that BrettPhos outperformed Xantphos in the Suzuki screen?',
    requested_by: 'oid-1',
  },
  {
    approval_id: 'approval-int-2',
    question: 'Add the measured pKa of 4.76 to the acetic acid note?',
    requested_by: 'oid-1',
  },
];

const renderInbox = () =>
  render(
    <AuthGate>
      <ApprovalsInbox />
    </AuthGate>,
  );

/** Open the panel by its count-bearing name. */
async function openInbox(name: RegExp): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name }));
}

/** Open the named decision's confirmation and commit it — the same two steps the plan gate takes. */
async function decideVia(trigger: HTMLElement, confirmName: RegExp): Promise<void> {
  fireEvent.click(trigger);
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: confirmName }));
}

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

afterEach(cleanup);

describe('approvals inbox', () => {
  it('says how many holds are waiting without being opened', async () => {
    // The count belongs in the accessible name, not only in the badge. The badge is the entire
    // signal, and someone tabbing the header has to hear it without opening a panel.
    vi.spyOn(api, 'listApprovals').mockResolvedValue(HOLDS);
    renderInbox();

    expect(await screen.findByRole('button', { name: /Approvals — 2 waiting/ })).toBeTruthy();
  });

  it('distinguishes an empty queue from a queue it could not read', async () => {
    // The failure this exists to prevent: a queue of unsigned approvals reading "all clear"
    // because the query threw. `listApprovals` degrades only on a 404 (an older service);
    // anything else has to surface.
    vi.spyOn(api, 'listApprovals').mockRejectedValue(new Error('temporal unreachable'));
    renderInbox();

    await openInbox(/could not be loaded/);

    expect(await screen.findByText(/could not be read/)).toBeTruthy();
    expect(screen.queryByText(/Nothing waiting/)).toBeNull();
  });

  it('reads the queue again when it is opened', async () => {
    // A hold answered inline in the transcript is already gone server-side. Without this the panel
    // would show it as still waiting until the next poll, up to a minute later.
    const list = vi.spyOn(api, 'listApprovals').mockResolvedValue(HOLDS);
    renderInbox();
    await screen.findByRole('button', { name: /2 waiting/ });
    const before = list.mock.calls.length;

    await openInbox(/2 waiting/);

    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(before));
  });

  it('delivers a decision to the route that records it, behind a confirmation', async () => {
    vi.spyOn(api, 'listApprovals').mockResolvedValue(HOLDS);
    const decide = vi.spyOn(api, 'decideApproval').mockResolvedValue();
    renderInbox();
    await openInbox(/2 waiting/);
    await screen.findByText(/BrettPhos outperformed Xantphos/);

    const approve = screen.getAllByRole('button', { name: 'Approve' })[0]!;

    // One tap must not be enough: the decision is irreversible and attributable.
    fireEvent.click(approve);
    expect(decide).not.toHaveBeenCalled();
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Approve',
      }),
    );

    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(decide.mock.calls[0]?.slice(0, 2)).toEqual(['approval-int-1', true]);
  });

  it('keeps the answered row on screen until the panel is closed', async () => {
    // The row is the only confirmation the click gets, so removing it at decision time would take
    // that confirmation with it. Retiring it on close is what stops it coming back on the next
    // open, before the poll has caught up.
    // A fake that behaves like the service rather than a constant: a decided hold stops being
    // listed. Without that, the reopen below would be asserting against the mock.
    let queue = [...HOLDS];
    vi.spyOn(api, 'listApprovals').mockImplementation(() => Promise.resolve(queue));
    vi.spyOn(api, 'decideApproval').mockImplementation((approvalId) => {
      queue = queue.filter((hold) => hold.approval_id !== approvalId);
      return Promise.resolve();
    });
    renderInbox();
    await openInbox(/2 waiting/);
    await screen.findByText(/BrettPhos outperformed Xantphos/);

    await decideVia(screen.getAllByRole('button', { name: 'Approve' })[0]!, /^Approve$/);

    expect(await screen.findByText(/You approved this request/)).toBeTruthy();
    expect(screen.getByText(/BrettPhos outperformed Xantphos/)).toBeTruthy();

    // The trigger is `aria-hidden` while the panel is open — Radix hides everything outside the
    // dialog, correctly — so the count is only assertable from where a reader would see it.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(await screen.findByRole('button', { name: /Approvals — 1 waiting/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /1 waiting/ }));
    expect(await screen.findByText(/measured pKa of 4.76/)).toBeTruthy();
    expect(screen.queryByText(/BrettPhos outperformed Xantphos/)).toBeNull();
  });
});
