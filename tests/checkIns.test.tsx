/**
 * The chemist's own blocked work, from the store to the screen.
 *
 * `GET /check-ins` was served by the service and named by **no file in this repository** — the
 * fourth route in a row to reach production with nothing reading it, after `/jobs`, `/proposals`
 * and `/profiles`. What the service puts in that mailbox is the only thing that ever tells a
 * requester their own question is still open before it expires: `durable/awaiting.py` re-notifies
 * the person who has to answer, and writes to the person who asked exactly once, on expiry, up to
 * 90 days later.
 *
 * Two properties carry the weight here and neither is cosmetic:
 *
 *  1. **An empty list is not good news on its own.** `api.listCheckIns` swallows a 404 into `[]`
 *     like every other list route, and a failed claim leaves the same empty array as an empty
 *     mailbox. `/review` has now deleted two sections that got this wrong, so the three states are
 *     driven separately here — and the fourth, a failure on a page that is already holding cards.
 *  2. **The read is the consume.** A row the service returns is never re-delivered, so the cards
 *     are the only copy: dismissal is a flag, a failed claim may not clear them, and a re-claim of
 *     the same question must *refresh* its day counts rather than drop them as a duplicate — the
 *     sweep re-sends every night with one day less left, and a card that kept the first answer
 *     would be overstating a deadline the service deliberately floors to avoid overstating.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { useChatStore } from '../src/state/chatStore.ts';
import { ReviewQueue } from '../src/components/ReviewQueue.tsx';
import type { CheckIn } from '../src/api/client.ts';
import { stubFetch } from './helpers.ts';

/** One blocked question, exactly as `CheckInOut` serialises it — all six fields, always. */
const row = (over: Partial<CheckIn> = {}): CheckIn => ({
  request_id: 'await-1',
  subject: 'Measured yield for the 2-MeTHF arm',
  rationale: 'Round 4 conditions cannot be chosen until round 3 is measured.',
  asked_of: 'process-chemistry',
  open_days: 9,
  days_left: 5,
  ...over,
});

/**
 * The three sections above this one read the service, so the page needs an auth context.
 *
 * A stable value, as `reviewQueue.test.tsx` records: a fresh object per render re-fires every
 * `[auth]` effect on every render, which is a fetch per render rather than a fetch per mount.
 */
vi.mock('../src/auth/AuthContext.tsx', () => {
  const auth = {
    getAccessToken: async () => null,
    mode: 'dev' as const,
    account: { id: 'u', username: 'u', name: 'u', roles: [] as string[] },
  };
  const value = { auth, ready: true, revision: 0 };
  return { useAuth: () => value, useIsReviewer: () => true };
});

let restore: (() => void) | null = null;

/**
 * The page under a router, with the other three sections answered and out of the way.
 *
 * `/plans/pending` is tested before `/pending` because it also ends in it — the same ordering trap
 * `reviewQueue.test.tsx` records. Nothing here stubs `/check-ins`: the claim runs once at the top
 * of the app, not from this screen, so what the section renders is whatever the store holds.
 */
function renderQueue(): void {
  const stub = stubFetch((url) => {
    const body = url.includes('/plans/pending')
      ? { plans: [], considered: 0, gated: 0, unread: 0, truncated: false }
      : { requests: [], count: 0 };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  restore = stub.restore;
  render(
    <MemoryRouter initialEntries={['/review']}>
      <ReviewQueue />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  // The claim state matters as much as the rows, so both are reset: a test that inherited `ready`
  // from the one before it would assert the empty state over a claim that never happened.
  useChatStore.setState({ checkIns: [], checkInClaim: 'pending' });
});

afterEach(() => {
  restore?.();
  restore = null;
});

describe('the check-in store', () => {
  it('maps the wire shape onto a card, keeping the numbers the service floored', () => {
    useChatStore.getState().addCheckIns([row()]);
    const [card] = useChatStore.getState().checkIns;
    expect(card).toMatchObject({
      requestId: 'await-1',
      subject: 'Measured yield for the 2-MeTHF arm',
      askedOf: 'process-chemistry',
      openDays: 9,
      daysLeft: 5,
      dismissed: false,
    });
    expect(useChatStore.getState().checkInClaim).toBe('ready');
  });

  it('an empty claim is an answer, not an absence of one', () => {
    // The whole reason the claim's outcome is a field rather than `checkIns.length === 0`.
    useChatStore.getState().addCheckIns([]);
    expect(useChatStore.getState().checkInClaim).toBe('ready');
  });

  it('refreshes a question it already holds instead of stacking a second card', () => {
    useChatStore.getState().addCheckIns([row()]);
    const first = useChatStore.getState().checkIns[0]?.receivedAt ?? 0;
    useChatStore.getState().addCheckIns([row({ open_days: 10, days_left: 4 })]);

    const cards = useChatStore.getState().checkIns;
    expect(cards).toHaveLength(1);
    // The later number wins: the sweep counts down, and a card that kept "5 left" would overstate
    // a deadline by a day — the direction the service's own `FLOOR` exists to avoid.
    expect(cards[0]).toMatchObject({ openDays: 10, daysLeft: 4 });
    // And it keeps the time it first arrived, so a nine-day-old question is not restamped as news.
    expect(cards[0]?.receivedAt).toBe(first);
  });

  it('folds a question that arrives twice in one claim into one card', () => {
    // The route flattens its answer out of every claimed mailbox row, and "one unread row per
    // requester" is something the sweep maintains rather than something this client is told. Two
    // cards for one question would read as two questions.
    useChatStore.getState().addCheckIns([row(), row({ days_left: 4 })]);
    const cards = useChatStore.getState().checkIns;
    expect(cards).toHaveLength(1);
    expect(cards[0]?.daysLeft).toBe(4);
  });

  it('a refreshed question stays dismissed', () => {
    useChatStore.getState().addCheckIns([row()]);
    useChatStore.getState().dismissCheckIn('await-1');
    useChatStore.getState().addCheckIns([row({ days_left: 4 })]);
    expect(useChatStore.getState().checkIns[0]?.dismissed).toBe(true);
  });

  it('keeps a newly claimed question above the ones already held', () => {
    useChatStore.getState().addCheckIns([row()]);
    useChatStore.getState().addCheckIns([row({ request_id: 'await-2', subject: 'A new one' })]);
    expect(useChatStore.getState().checkIns.map((c) => c.requestId)).toEqual([
      'await-2',
      'await-1',
    ]);
  });

  it('a failed claim does not clear the cards an earlier page claimed', () => {
    // They are the only copy there is — the service consumed its own when it answered.
    useChatStore.getState().addCheckIns([row()]);
    useChatStore.getState().failCheckInClaim();
    expect(useChatStore.getState().checkIns).toHaveLength(1);
    expect(useChatStore.getState().checkInClaim).toBe('failed');
  });

  it('persists the cards and not the outcome of the claim', () => {
    // The rows survive a reload because the claim that produced them cannot be repeated. The
    // outcome must not: a stored `failed` would outlive the failure, and a stored `ready` would
    // outlive the evidence for it — the next page claims again.
    useChatStore.getState().addCheckIns([row()]);
    const persisted = useChatStore.persist.getOptions().partialize?.(useChatStore.getState());
    expect(persisted).toHaveProperty('checkIns');
    expect(persisted).not.toHaveProperty('checkInClaim');
  });

  it('does not drop a card for being unread', () => {
    // Aged out on the same clock as the digest feed, never on having been seen: an unread check-in
    // is exactly the one whose loss the sweep exists to prevent.
    useChatStore.getState().addCheckIns([row()]);
    const persisted = useChatStore.persist.getOptions().partialize?.(useChatStore.getState()) as {
      checkIns: unknown[];
    };
    expect(persisted.checkIns).toHaveLength(1);
  });
});

describe('the check-in section', () => {
  it('says it is still reading before the claim has answered', () => {
    renderQueue();
    expect(screen.getByText('Reading what you are waiting on…')).toBeTruthy();
  });

  it('says nothing is blocked only once the service has said so', () => {
    useChatStore.setState({ checkInClaim: 'ready' });
    renderQueue();
    expect(screen.getByText('Nothing of yours is blocked')).toBeTruthy();
  });

  it('a failed claim reads as a failure, never as an empty mailbox', () => {
    useChatStore.setState({ checkInClaim: 'failed' });
    renderQueue();
    expect(screen.queryByText('Nothing of yours is blocked')).toBeNull();
    const alerts = screen.getAllByRole('alert').map((el) => el.textContent ?? '');
    expect(
      alerts.some((text) => text.includes('could not be asked what your work is waiting on')),
    ).toBe(true);
  });

  it('renders the question, who owes it, and how long is left', () => {
    useChatStore.getState().addCheckIns([row()]);
    renderQueue();
    expect(screen.getByText('Measured yield for the 2-MeTHF arm')).toBeTruthy();
    expect(screen.getByText('5 days left')).toBeTruthy();
    expect(screen.getByText(/waiting on process-chemistry · open 9 days/).textContent).toBeTruthy();
    expect(
      screen.getByText('Round 4 conditions cannot be chosen until round 3 is measured.'),
    ).toBeTruthy();
  });

  it('reads a floored zero as under a day rather than as expired', () => {
    // The service floors, and excludes anything already past its deadline — so 0 means "less than
    // a day", and "0 days left" would be telling a chemist the opposite of what is true.
    useChatStore.getState().addCheckIns([row({ days_left: 0 })]);
    renderQueue();
    expect(screen.getByText('less than a day left')).toBeTruthy();
    expect(screen.queryByText('0 days left')).toBeNull();
  });

  it('says "anyone" where the service sent no assignee', () => {
    useChatStore.getState().addCheckIns([row({ asked_of: '' })]);
    renderQueue();
    expect(screen.getByText(/waiting on anyone/)).toBeTruthy();
  });

  it('still shows the cards when the latest claim failed, and says the claim failed', () => {
    // The cards came from an earlier page and are still the only copy of what they say; the
    // failure is about whether anything has been *added* since, which is a different fact.
    useChatStore.getState().addCheckIns([row()]);
    useChatStore.getState().failCheckInClaim();
    renderQueue();
    expect(screen.getByText('Measured yield for the 2-MeTHF arm')).toBeTruthy();
    const alerts = screen.getAllByRole('alert').map((el) => el.textContent ?? '');
    expect(
      alerts.some((text) => text.includes('could not be asked what your work is waiting on')),
    ).toBe(true);
  });

  it('dismissing one takes it off the screen and leaves the rest', () => {
    useChatStore.getState().addCheckIns([row(), row({ request_id: 'await-2', subject: 'Second' })]);
    renderQueue();
    const dismiss = screen.getAllByRole('button', { name: 'Dismiss' });
    expect(dismiss).toHaveLength(2);
    // The first card is the first row of the claim — both arrived together, so neither is newer.
    fireEvent.click(dismiss[0] as HTMLElement);
    expect(screen.queryByText('Measured yield for the 2-MeTHF arm')).toBeNull();
    expect(screen.getByText('Second')).toBeTruthy();
    // A flag rather than a delete: the row is still the only copy of a question nobody answered.
    expect(useChatStore.getState().checkIns).toHaveLength(2);
  });

  it('gives the section a heading its own list is labelled by', () => {
    useChatStore.setState({ checkInClaim: 'ready' });
    renderQueue();
    const heading = screen.getByRole('heading', {
      name: 'Your work waiting on somebody else',
      level: 2,
    });
    expect(heading.getAttribute('id')).toBe('check-ins-heading');
  });
});
