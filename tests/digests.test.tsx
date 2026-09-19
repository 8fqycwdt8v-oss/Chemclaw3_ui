/**
 * What a standing query turned up, from the wire to the card.
 *
 * `GET /digests` sends four fields and this client declared two of them. The two it dropped are the
 * two a reader acts on.
 *
 * **`headlines`** is note id → one line of text, and the service's own model says why it exists:
 * "without it this route answers with note **ids** and a client can do nothing but print them".
 * That is exactly what the card did — a row of bare `note-…` chips, each one a sheet away from
 * saying anything.
 *
 * **`disputed`** is which of the matched notes the corpus now *disagrees with*. It has been
 * computed since `D-2026-08-27` and the outbound delivery channels render it, so a deployment with
 * a channel configured saw it and a deployment on the shipped default — `CHEMCLAW_DELIVERY_CHANNELS`
 * empty — lost it on the only path a UI reads. Upstream's own words for the asymmetry: "a chemist
 * who happens to ask is told, and a chemist watching the subject is not." It was still true one
 * layer down.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { useChatStore } from '../src/state/chatStore.ts';
import { ReviewQueue } from '../src/components/ReviewQueue.tsx';
import type { Digest } from '../src/api/client.ts';
import { stubFetch } from './helpers.ts';

/** One digest, exactly as the service serialises it — every field, always. */
const digest = (over: Partial<Digest> = {}): Digest => ({
  query: 'nitration selectivity on electron-poor arenes',
  note_ids: ['note-7f1', 'note-a02'],
  disputed: [],
  headlines: {
    'note-7f1': 'Mixed acid at 0 °C gives 9:1 para:ortho on the methyl ester.',
    'note-a02': 'Acetyl nitrate in DCM reverses the ratio below −10 °C.',
  },
  ...over,
});

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

/** The page under a router, with the other three sections answered and out of the way. */
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
  useChatStore.setState({ digests: [], checkIns: [], checkInClaim: 'ready' });
});

afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

describe('the digest store', () => {
  it('keeps the two fields a reader acts on', () => {
    useChatStore.getState().addDigests([digest({ disputed: ['note-a02'] })]);
    const [card] = useChatStore.getState().digests;
    expect(card).toMatchObject({
      query: 'nitration selectivity on electron-poor arenes',
      noteIds: ['note-7f1', 'note-a02'],
      disputed: ['note-a02'],
    });
    expect(card?.headlines?.['note-7f1']).toContain('Mixed acid at 0 °C');
  });
});

describe('the digest card', () => {
  it('prints what each note says, not only its id', () => {
    useChatStore.getState().addDigests([digest()]);
    renderQueue();

    expect(screen.getByText(/Mixed acid at 0 °C gives 9:1 para:ortho/)).toBeTruthy();
    expect(screen.getByText(/Acetyl nitrate in DCM reverses the ratio/)).toBeTruthy();
  });

  it('says which of the matched notes the corpus now disagrees with', () => {
    useChatStore.getState().addDigests([digest({ disputed: ['note-a02'] })]);
    renderQueue();

    const section = screen.getByRole('region', { name: /standing queries/i });
    expect(within(section).getByText(/1 of 2 disagree/)).toBeTruthy();
    // On the note itself as well as in the count: a reader scanning two headlines has to be able
    // to tell which one the graph argues with.
    const row = within(section)
      .getByText(/Acetyl nitrate in DCM/)
      .closest('li');
    expect(row && within(row as HTMLElement).getByText('disputed')).toBeTruthy();
  });

  it('says nothing about disputes when the service reported none', () => {
    // The count is a claim, and a card that printed "0 of 2 disagree" would be making one about a
    // corpus nobody consulted.
    useChatStore.getState().addDigests([digest()]);
    renderQueue();

    expect(screen.queryByText(/disagree/)).toBeNull();
    expect(screen.queryByText('disputed')).toBeNull();
  });
});
