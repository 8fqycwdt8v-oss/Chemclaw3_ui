/**
 * The PR gate, from the browser.
 *
 * This is the largest capability the service had and the UI did not touch. What the tests pin is
 * not that the list renders — it is the three properties that make a sign-off mean something:
 *
 *  - the reviewer sees **the bytes that would be committed**, including the files that land
 *    alongside the note, because a GxP decision is on what enters the tree and not on a summary;
 *  - **a rejection carries a reason**, which the service requires and which is the only thing the
 *    next reviewer and the agent have to go on;
 *  - **a non-reviewer is not offered a decision they cannot make**. Learning your permissions from
 *    a 403 is bad; learning them after forming a judgement you now cannot record is worse.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ReviewQueue } from '../src/components/ReviewQueue.tsx';
import { stubFetch } from './helpers.ts';

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

const SUMMARY = {
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

const DETAIL = {
  ...SUMMARY,
  content: '---\ntype: reaction\nconfidence: 0.8\n---\nRan in 2-MeTHF at 70 °C.',
  dependencies: [{ path: 'knowledge/compound/brettphos.md', content: '# BrettPhos' }],
  session_id: 'a'.repeat(32),
  correlation_id: 'turn-3',
};

let restore: (() => void) | null = null;
const decisions: unknown[] = [];

function serve(): void {
  const stub = stubFetch((url, init) => {
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
    // /approvals and anything else.
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  restore = stub.restore;
}

/** Open the one proposal in the queue. */
async function openProposal(): Promise<void> {
  render(<ReviewQueue />);
  fireEvent.click(await screen.findByRole('button', { name: /note-suzuki-42/ }));
  await screen.findByText(/Ran in 2-MeTHF/);
}

beforeEach(() => {
  cleanup();
  decisions.length = 0;
  mode.current = 'dev';
  mode.roles = [];
});
afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

describe('ReviewQueue', () => {
  it('lists what is waiting, with who proposed it', async () => {
    serve();
    render(<ReviewQueue />);
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
