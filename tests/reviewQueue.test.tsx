/**
 * The two gates, from the browser.
 *
 * The PR gate was the largest capability the service had and the UI did not touch. What the tests
 * pin is not that the list renders — it is the three properties that make a sign-off mean
 * something:
 *
 *  - the reviewer sees **the bytes that would be committed**, including the files that land
 *    alongside the note, because a GxP decision is on what enters the tree and not on a summary;
 *  - **a rejection carries a reason**, which the service requires and which is the only thing the
 *    next reviewer and the agent have to go on;
 *  - **a non-reviewer is not offered a decision they cannot make**. Learning your permissions from
 *    a 403 is bad; learning them after forming a judgement you now cannot record is worse.
 *
 * The plan inbox is the second gate and the newer half, and what it has to get right is the
 * opposite failure: **an empty list must never read as "nothing is waiting on you" unless that is
 * what the service said.** The section this one replaces got that wrong — it swallowed a 404 from
 * a deleted route into `[]` and rendered a confident empty queue for a release — so the tests
 * below drive each of the three emptinesses and the failure separately.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ReviewQueue } from '../src/components/ReviewQueue.tsx';
import { stubFetch } from './helpers.ts';
import { resetPendingPlansCache } from '../src/api/client.ts';
import type { PendingPlans, ProposalDetail, ProposalSummary } from '../src/api/client.ts';

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

/** Typed against the declaration, so a renamed field fails `tsc -b` rather than this fixture
 *  quietly describing a shape the gate route no longer sends. */
const SUMMARY: ProposalSummary = {
  id: 7,
  note_id: 'note-suzuki-42',
  note_type: 'reaction',
  state: 'pending',
  branch: 'agent/note-suzuki-42',
  reference: 'refs/heads/agent/note-suzuki-42',
  actor: 'chemist@example.com',
  submitted_at: '2026-08-09T10:00:00Z',
  decided_at: null,
  decided_by: '',
  reason: '',
};

const DETAIL: ProposalDetail = {
  ...SUMMARY,
  content: '---\ntype: reaction\nconfidence: 0.8\n---\nRan in 2-MeTHF at 70 °C.',
  dependencies: [{ path: 'knowledge/compound/brettphos.md', content: '# BrettPhos' }],
  session_id: 'a'.repeat(32),
  correlation_id: 'turn-3',
};

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
const decisions: unknown[] = [];
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
  const stub = stubFetch((url, init) => {
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
    if (url.includes('/proposals/7/decision')) {
      decisions.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    if (url.includes('/proposals/7')) {
      return new Response(JSON.stringify(DETAIL), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/proposals')) {
      return new Response(JSON.stringify([SUMMARY]), {
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

/** Open the one proposal in the queue. */
async function openProposal(): Promise<void> {
  renderQueue();
  fireEvent.click(await screen.findByRole('button', { name: /note-suzuki-42/ }));
  await screen.findByText(/Ran in 2-MeTHF/);
}

beforeEach(() => {
  cleanup();
  decisions.length = 0;
  pending = PENDING;
  mode.current = 'dev';
  mode.roles = [];
  // `GET /plans/pending` is the most expensive read one navigation here can trigger — up to 25
  // checkpointer reads, serialized against every concurrent turn on the pod — so the client holds
  // it for a short minimum interval and does not rescan when a reader bounces back into /review.
  // That interval is module-wide, and each test below mounts the inbox against a fixture of its
  // own, so without this one test answers the next one's question.
  resetPendingPlansCache();
});
afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

describe('ReviewQueue', () => {
  it('lists what is waiting, with who proposed it', async () => {
    serve();
    renderQueue();
    expect(await screen.findByText('note-suzuki-42')).toBeTruthy();
    expect(screen.getByText(/chemist@example\.com/)).toBeTruthy();
  });

  it('shows the exact bytes that would be committed, and the files beside them', async () => {
    // Not rendered markdown: a sign-off is on what lands in the tree, and rendering would hide
    // the front matter and the confidence field, which are what a reviewer is checking.
    serve();
    await openProposal();

    expect(screen.getByText(/confidence: 0\.8/)).toBeTruthy();
    expect(screen.getByText('knowledge/compound/brettphos.md')).toBeTruthy();
    // The join to the audit trail of the turn that wrote it.
    expect(screen.getByText('turn-3')).toBeTruthy();
  });

  it('will not let a rejection go out without a reason', async () => {
    serve();
    await openProposal();

    const reject = screen.getByRole('button', { name: 'Reject' });
    expect((reject as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'The yield is from a different batch.' },
    });
    expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('records the decision behind a confirmation, with its reason', async () => {
    serve();
    await openProposal();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'wrong batch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    // Irreversible and attributable, so it goes through the same confirmation every other
    // decision in this app does. Scoped to the dialog: the trigger carries the same label, and
    // matching either of them would make this test pass for the wrong reason.
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));

    await waitFor(() => expect(decisions).toHaveLength(1));
    expect(decisions[0]).toEqual({ approved: false, reason: 'wrong batch' });
  });

  it('does not offer a decision to someone without the role', async () => {
    mode.current = 'msal';
    mode.roles = ['reader'];
    serve();
    await openProposal();

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    // And says why, rather than leaving a reader wondering where the buttons went.
    expect(screen.getByText(/needs a reviewer role/)).toBeTruthy();
  });

  it('still shows the proposal to a non-reviewer, because reading it is the point', async () => {
    // `GET /proposals` already narrows a non-reviewer to their own proposals. A chemist reading
    // why their note was rejected is exactly who this screen is for.
    mode.current = 'msal';
    mode.roles = [];
    serve();
    await openProposal();

    expect(screen.getByText(/Ran in 2-MeTHF/)).toBeTruthy();
  });
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
    // The second mount is immediate, and a remount inside the client's minimum interval is exactly
    // what that interval refuses to rescan for. This test is about the two *renderings* of a
    // bounded scan, so it asks for a fresh answer rather than pretending the second one is one.
    resetPendingPlansCache();
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
