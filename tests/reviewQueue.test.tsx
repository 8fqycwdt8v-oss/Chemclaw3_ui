/**
 * The gate that is left, from the browser.
 *
 * This file used to open on the PR gate — the reviewer seeing the bytes that would be committed, a
 * rejection carrying its reason, a non-reviewer not being offered a decision. Chemclaw3 deleted
 * that gate and its `/proposals` routes
 * (`D-2026-09-05-the-gate-follows-behaviour-not-knowledge`), so those tests went with the section
 * they covered.
 *
 * What remains is the plan inbox, and what it has to get right is the failure that has now bitten
 * this page **twice**: **an empty list must never read as "nothing is waiting on you" unless that
 * is what the service said.** Both deleted sections got it wrong the same way — the client
 * swallows a 404 on a list route into `[]`, so each rendered a confident empty queue for a release
 * — which is why the tests below drive each of the three emptinesses and the failure separately.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ReviewQueue } from '../src/components/ReviewQueue.tsx';
import { stubFetch } from './helpers.ts';
import type { PendingPlans } from '../src/api/client.ts';

const mode = { current: 'dev' as 'dev' | 'msal', roles: [] as string[] };

vi.mock('../src/auth/AuthContext.tsx', async () => {
  const { config } = await import('../src/env.ts');
  // Stable identity, as the real context value is. Returning a fresh object per render makes
  // every `[auth]` effect re-fire on every render, which here meant a fetch per keystroke.
  const auth = {
    getAccessToken: async () => null,
    get mode() {
      return mode.current;
    },
    get account() {
      return { id: 'u', username: 'u', name: 'u', roles: mode.roles };
    },
  };
  const value = { auth, ready: true, revision: 0 };
  return {
    useAuth: () => value,
    // The real implementation, re-expressed against the stub above: the point of these tests is
    // the gate's behaviour, and mocking it away would test nothing.
    useIsReviewer: () =>
      mode.current === 'dev' || config.reviewerRoles.some((r) => mode.roles.includes(r)),
  };
});

/** One conversation blocked on a decision, as `GET /plans/pending` reports it. */
const PENDING: PendingPlans = {
  plans: [
    {
      session_id: 'b'.repeat(32),
      title: 'Which solvent for the Suzuki step?',
      updated_at: '2026-08-09T09:00:00Z',
      plan_hash: 'plan-hash-1',
      plan: ['screen the hazards of 2-MeTHF', 'record the comparison as a note'],
    },
  ],
  considered: 4,
  gated: 2,
  unread: 0,
};

let restore: (() => void) | null = null;
/** What the plan inbox route answers this test — replaced per test, never per assertion. */
let pending: PendingPlans | 'fails' = PENDING;

/** The screen under a router, which `Link` needs and the app always provides. */
function renderQueue(): void {
  render(
    <MemoryRouter>
      <ReviewQueue />
    </MemoryRouter>,
  );
}

function serve(): void {
  const stub = stubFetch((url) => {
    if (url.includes('/plans/pending')) {
      if (pending === 'fails') {
        return new Response(JSON.stringify({ detail: 'boom' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(pending), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // The third gate on this page, and it must be tested AFTER `/plans/pending` — which also ends
    // in `/pending`, and swallowing it here made every test on this page fail at once.
    if (/\/pending$/.test(url) || url.includes('/pending/')) {
      return new Response(JSON.stringify({ requests: [], count: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // Anything else.
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  restore = stub.restore;
}

beforeEach(() => {
  cleanup();
  pending = PENDING;
  mode.current = 'dev';
  mode.roles = [];
});
afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

describe('the plan inbox', () => {
  it('names the blocked conversation, shows the work, and links into it', async () => {
    // The session id is the field that makes this screen worth having: it is the one thing a
    // chemist who closed the tab cannot reconstruct, and `/s/:sessionId` is the only route that
    // turns it back into a readable conversation.
    serve();
    renderQueue();

    expect(await screen.findByText('Which solvent for the Suzuki step?')).toBeTruthy();
    expect(screen.getByText('screen the hazards of 2-MeTHF')).toBeTruthy();
    const link = screen.getByRole('link', { name: /Open the conversation/ });
    expect(link.getAttribute('href')).toBe(`/s/${'b'.repeat(32)}`);
  });

  it('offers no decision here, because the reasoning is in the conversation', async () => {
    // The service binds a decision to the hash of the plan as displayed, so deciding from here
    // would be *safe*. It would not be informed — a plan is approved on the strength of the
    // reasoning that produced it, and that is one click away rather than on this screen.
    serve();
    renderQueue();
    await screen.findByText('Which solvent for the Suzuki step?');

    expect(screen.queryByRole('button', { name: /^Approve$/ })).toBeNull();
  });

  it('says the deployment does not gate plans, rather than that nothing is waiting', async () => {
    // `gated === 0`: no conversation of this chemist's runs a profile that holds work for
    // approval, so nothing can ever appear here. Rendering that as an empty queue is the failure
    // the deleted holds inbox shipped — a confident emptiness the deployment could not back.
    pending = { plans: [], considered: 3, gated: 0, unread: 0 };
    serve();
    renderQueue();

    expect(await screen.findByText(/Nothing here asks before it acts/)).toBeTruthy();
    expect(screen.queryByText(/No plan is waiting on you/)).toBeNull();
  });

  it('separates "no conversations yet" from "nothing waiting"', async () => {
    pending = { plans: [], considered: 0, gated: 0, unread: 0 };
    serve();
    renderQueue();

    expect(await screen.findByText(/No conversations to check/)).toBeTruthy();
  });

  it('says the queue is genuinely empty when it is', async () => {
    pending = { plans: [], considered: 3, gated: 3, unread: 0 };
    serve();
    renderQueue();

    expect(await screen.findByText(/No plan is waiting on you/)).toBeTruthy();
  });

  it('admits when the scan did not cover everything', async () => {
    // A short list that looks complete is the shape that tells a chemist nothing is waiting while
    // something is. The service bounds its scan; this has to say so on both paths — with rows and
    // without them.
    pending = { ...PENDING, unread: 2 };
    serve();
    renderQueue();

    expect(await screen.findByText(/2 older conversations were not checked/)).toBeTruthy();

    cleanup();
    pending = { plans: [], considered: 30, gated: 30, unread: 5 };
    renderQueue();
    expect(await screen.findByText(/5 older conversations were not checked/)).toBeTruthy();
  });

  it('says the question could not be asked, instead of answering it with an empty list', async () => {
    // `listPendingPlans` deliberately does not swallow the failure into `[]`. "We could not ask"
    // and "nothing is waiting" are opposite things to tell somebody whose work is blocked.
    pending = 'fails';
    serve();
    renderQueue();

    expect(await screen.findByText(/could not be asked which plans are waiting/)).toBeTruthy();
    expect(screen.queryByText(/No plan is waiting on you/)).toBeNull();
  });
});
