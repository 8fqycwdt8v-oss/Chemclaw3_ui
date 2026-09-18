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

/** One blocked question, exactly as `CheckInOut` serialises it — every field, always. */
const row = (over: Partial<CheckIn> = {}): CheckIn => ({
  request_id: 'await-1',
  kind: 'measurement',
  subject: 'Measured yield for the 2-MeTHF arm',
  rationale: 'Round 4 conditions cannot be chosen until round 3 is measured.',
  asked_of: 'process-chemistry',
  open_days: 9,
  days_left: 5,
  session_id: 'conv-7',
  truncated: false,
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

  it('keeps the three fields the card badges, links and warns by', () => {
    // Each was added upstream at a different layer — `kind` at the wire, `session_id` at the
    // sweep's own query, `truncated` on the payload the workflow writes — and the card needs all
    // three. A card that dropped one here would read as a service that never sent it.
    useChatStore.getState().addCheckIns([row({ truncated: true })]);
    const [card] = useChatStore.getState().checkIns;
    expect(card).toMatchObject({ kind: 'measurement', sessionId: 'conv-7', truncated: true });
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

  it('badges the question by the class of answer it wants', () => {
    // The same field the pending inbox two sections up badges every row by, off `GET /pending`.
    // Without it the two inboxes on one page grouped their rows differently for no reason a
    // reader could see.
    useChatStore.getState().addCheckIns([row()]);
    renderQueue();
    expect(screen.getByText('measurement')).toBeTruthy();
  });

  it('ends the row in the conversation that raised it, as both other inboxes do', () => {
    useChatStore.getState().addCheckIns([row()]);
    renderQueue();
    const link = screen.getByRole('link', { name: /open the conversation/i });
    expect(link.getAttribute('href')).toBe('/open/conv-7');
  });

  it('offers no conversation where the service sent no session', () => {
    // A wait opened by a BO plate run or a connector job has none, and `AwaitRequest.session_id`
    // defaults to empty for exactly those. A link to `/open/` would be a dead end this page
    // invented.
    useChatStore.getState().addCheckIns([row({ session_id: '' })]);
    renderQueue();
    expect(screen.queryByRole('link', { name: /open the conversation/i })).toBeNull();
  });

  it('says the list may be short when the sweep served the requester short', () => {
    // `PartialScan` says exactly this for plans one section up. Without it a chemist with more
    // than 200 open questions is shown a list that looks complete — the confident emptiness this
    // page refuses everywhere else.
    useChatStore.getState().addCheckIns([row({ truncated: true })]);
    renderQueue();
    expect(screen.getByText(/this list may be short/i)).toBeTruthy();
  });

  it('claims nothing about completeness when the service did not', () => {
    useChatStore.getState().addCheckIns([row()]);
    renderQueue();
    expect(screen.queryByText(/this list may be short/i)).toBeNull();
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

describe('a question the service sent with no request id', () => {
  it('is two cards when it is two questions, not one card that swallowed the other', () => {
    // `CheckInOut.request_id` is `str` with `""` available, and `addCheckIns` keyed on it raw — so
    // every id-less row shared the key `''` and the second question overwrote the first. The
    // fallback key is the pair a reader distinguishes them by, joined on a separator no subject or
    // rationale can contain.
    useChatStore
      .getState()
      .addCheckIns([
        row({ request_id: '', subject: 'Which base for the telescoped step' }),
        row({ request_id: '', subject: 'Is the 40 °C hold still needed' }),
      ]);
    const cards = useChatStore.getState().checkIns;
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.subject).sort()).toEqual([
      'Is the 40 °C hold still needed',
      'Which base for the telescoped step',
    ]);
  });

  it('is still refreshed rather than duplicated when the sweep re-sends it', () => {
    // The other direction: the composite key has to be *stable*, or an id-less question stacks a
    // fresh card every night the sweep re-sends it, and a chemist sees nine copies of one question.
    useChatStore.getState().addCheckIns([row({ request_id: '', days_left: 5 })]);
    useChatStore.getState().addCheckIns([row({ request_id: '', days_left: 4 })]);
    const cards = useChatStore.getState().checkIns;
    expect(cards).toHaveLength(1);
    expect(cards[0]?.daysLeft).toBe(4);
  });

  it('dismisses the one that was clicked and leaves its neighbour', () => {
    // The consequence of the key change that `dismissCheckIn` had to follow: dismissing by the raw
    // id would have marked every id-less card at once.
    useChatStore
      .getState()
      .addCheckIns([
        row({ request_id: '', subject: 'First' }),
        row({ request_id: '', subject: 'Second' }),
      ]);
    renderQueue();
    const dismiss = screen.getAllByRole('button', { name: 'Dismiss' });
    expect(dismiss).toHaveLength(2);
    fireEvent.click(dismiss[0] as HTMLElement);
    expect(useChatStore.getState().checkIns.filter((c) => c.dismissed)).toHaveLength(1);
  });
});

describe('a deployment with no check-in mailbox', () => {
  it('is not reported as an empty mailbox', () => {
    // A 404 used to become `[]` like every other list route, so a deployment that does not serve
    // the route told every chemist their work was unblocked. The route's absence is a fact about
    // the *service*, and the only honest thing to say about their work is nothing.
    useChatStore.getState().markCheckInsAbsent();
    expect(useChatStore.getState().checkInClaim).toBe('absent');
    renderQueue();
    expect(screen.queryByText('Nothing of yours is blocked')).toBeNull();
    expect(screen.getByText('No check-in mailbox here')).toBeTruthy();
  });

  it('does not clear cards an earlier page claimed from a service that did serve it', () => {
    // Same argument as `failCheckInClaim`: the rows are the only copy, and a rolling deploy can
    // put a page that has cards in front of a replica that does not serve the route.
    useChatStore.getState().addCheckIns([row()]);
    useChatStore.getState().markCheckInsAbsent();
    expect(useChatStore.getState().checkIns).toHaveLength(1);
    renderQueue();
    expect(screen.getByText('Measured yield for the 2-MeTHF arm')).toBeTruthy();
  });
});

/**
 * The two halves that decide whether a check-in reaches disk, and what reaches it.
 *
 * Both are invisible from the store's own API: `partialize` and the cross-tab fold run inside the
 * persist middleware, so what each one *decides* is only observable by driving a real write. The
 * module registry is reset per test for the reason `persistBudget.test.ts` gives — `storageWritable`
 * is module scope and latches.
 */
describe('what a check-in does on the way to disk', () => {
  const KEY = 'chemclaw3.chat.v2.anon';
  const WEEK = 7 * 24 * 60 * 60 * 1000;

  /** A store module of this test's own, and a `localStorage` it can read back. */
  async function freshStore() {
    vi.resetModules();
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      length: 0,
      key: () => null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    return { store, ...(await import('../src/state/chatStore.ts')) };
  }

  /** What a second tab left on disk, in the shape `mergeWithStored` parses. */
  const onDisk = (store: Map<string, string>, checkIns: unknown[]): void => {
    store.set(
      KEY,
      JSON.stringify({
        version: 3,
        state: {
          conversations: {},
          order: [],
          activeId: null,
          drafts: {},
          jobFeed: [],
          digests: [],
          checkIns,
          notifyOnJobComplete: false,
        },
      }),
    );
  };

  const stored = (over: Record<string, unknown> = {}) => ({
    requestId: 'await-1',
    subject: 'Measured yield for the 2-MeTHF arm',
    rationale: 'Round 4 conditions cannot be chosen until round 3 is measured.',
    askedOf: 'process-chemistry',
    openDays: 9,
    daysLeft: 5,
    receivedAt: Date.now(),
    refreshedAt: Date.now(),
    dismissed: false,
    ...over,
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('an aged-out card that `partialize` dropped does not come back through the fold', async () => {
    // `partialize` filtered on the cutoff and the fold then folded every stored row the new state
    // did not know straight back in — so the card `partialize` had just dropped was written again,
    // rehydrated on the next load, dropped, and written again, for ever. A stale digest is a stale
    // finding; a stale check-in says a deadline that is a week wrong.
    const { store, useChatStore, flushChatPersistence } = await freshStore();
    onDisk(store, [stored({ requestId: 'old', receivedAt: Date.now() - WEEK - 1_000 })]);

    const id = useChatStore.getState().createConversation();
    useChatStore.getState().appendUserMessage(id, 'q');
    flushChatPersistence();

    expect(store.get(KEY) ?? '').not.toContain('"requestId":"old"');
  });

  it('carries a card the other tab claimed and this one has never seen', async () => {
    // The complement, and the whole reason the fold exists: `GET /check-ins` consumes what it
    // answers, so a row only the other tab claimed is a row nothing can re-fetch.
    const { store, useChatStore, flushChatPersistence } = await freshStore();
    onDisk(store, [stored({ requestId: 'theirs', subject: 'Claimed in the other window' })]);

    const id = useChatStore.getState().createConversation();
    useChatStore.getState().appendUserMessage(id, 'q');
    flushChatPersistence();

    expect(store.get(KEY) ?? '').toContain('Claimed in the other window');
  });

  it('keeps the fresher of two copies of one question, whichever tab holds it', async () => {
    // A check-in's identity is the question and its content is a *countdown*, so the two copies
    // differ in exactly the part that matters and "ours wins" is the wrong rule — measured before
    // the `fresher` argument existed, a tab open since yesterday overwrote this morning's refresh
    // and showed a deadline a day more generous than the truth.
    const { store, useChatStore, flushChatPersistence } = await freshStore();
    const now = Date.now();
    onDisk(store, [stored({ refreshedAt: now, daysLeft: 3, openDays: 11 })]);

    // This tab's copy is the older claim: same question, a day's more slack, refreshed earlier.
    useChatStore.setState({
      checkIns: [
        {
          requestId: 'await-1',
          kind: 'measurement',
          subject: 'Measured yield for the 2-MeTHF arm',
          rationale: 'Round 4 conditions cannot be chosen until round 3 is measured.',
          askedOf: 'process-chemistry',
          sessionId: 'conv-7',
          truncated: false,
          openDays: 10,
          daysLeft: 4,
          receivedAt: now - 1_000,
          refreshedAt: now - 1_000,
          dismissed: false,
        },
      ],
    });
    flushChatPersistence();

    const written = JSON.parse(store.get(KEY) ?? '{}') as {
      state: { checkIns: { daysLeft: number; openDays: number }[] };
    };
    expect(written.state.checkIns).toHaveLength(1);
    expect(written.state.checkIns[0]).toMatchObject({ daysLeft: 3, openDays: 11 });
  });

  it('does not let the stale copy win just because this tab wrote last', async () => {
    // The same fold in the other direction — `fresher` compares `refreshedAt`, not which side of
    // the merge a row arrived on.
    const { store, useChatStore, flushChatPersistence } = await freshStore();
    const now = Date.now();
    onDisk(store, [stored({ refreshedAt: now - 86_400_000, daysLeft: 5, openDays: 9 })]);

    useChatStore.setState({
      checkIns: [
        {
          requestId: 'await-1',
          kind: 'measurement',
          subject: 'Measured yield for the 2-MeTHF arm',
          rationale: 'Round 4 conditions cannot be chosen until round 3 is measured.',
          askedOf: 'process-chemistry',
          sessionId: 'conv-7',
          truncated: false,
          openDays: 10,
          daysLeft: 4,
          receivedAt: now - 86_400_000,
          refreshedAt: now,
          dismissed: false,
        },
      ],
    });
    flushChatPersistence();

    const written = JSON.parse(store.get(KEY) ?? '{}') as {
      state: { checkIns: { daysLeft: number }[] };
    };
    expect(written.state.checkIns).toHaveLength(1);
    expect(written.state.checkIns[0]?.daysLeft).toBe(4);
  });
});
