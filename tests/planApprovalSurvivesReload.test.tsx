/**
 * The decision that blocks work has to survive a reload.
 *
 * The approval card is built from an `approval_request` trace entry, and a reload rebuilds a
 * conversation from the stored transcript — which carries messages and tool calls and no signals at
 * all (`state/transcript.ts` says so in its own docstring). So the card was lost on every reload,
 * on every second device, and on every shared link, while `agent/plan_gate` went on refusing every
 * state-changing call. The only way out was to send another message purely to make the service
 * re-emit the event: a chemist re-asking a question in order to unstick a decision they already
 * knew they owed.
 *
 * `GET /sessions/{id}/plan` answers this and was already being called on exactly this path to
 * restore the checklist — `approved` was fetched and thrown away. What is pinned here is that it is
 * used, that it is used only when a decision is actually outstanding, and that re-running the
 * rehydrate does not stack a second Approve button on one message.
 *
 * `approved` is the EFFECTIVE state upstream: the route folds `consumed_at` in, so a plan whose
 * approval has been spent comes back false — which is right, because that is exactly when another
 * decision is owed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { useChatStore, newConversation } from '../src/state/chatStore.ts';
import { AuthGate } from '../src/auth/AuthContext.tsx';
import { AppShell } from '../src/App.tsx';
import { stubFetch } from './helpers.ts';

const SID = 'a'.repeat(32);

const TRANSCRIPT = [
  { index: 0, role: 'user', text: 'Run xTB on the aryl bromide.', tool_calls: [] },
  { index: 1, role: 'assistant', text: 'Here is what I propose.', tool_calls: [] },
];

const planStatus = (approved: boolean) => ({
  session_id: SID,
  plan_hash: 'h-restored',
  plan: ['[ ] Run xTB on the aryl bromide', '[x] Check the hazard profile'],
  mode: approved ? 'execute' : 'plan',
  approved,
  decided_by: approved ? 'someone' : null,
});

/** A conversation whose transcript lives on the server — the shape a reload produces. */
const seed = (): string => {
  const conversation = { ...newConversation(), sessionId: SID, sessionOrigin: 'server' as const };
  useChatStore.setState({
    conversations: { [conversation.id]: conversation },
    order: [conversation.id],
    activeId: conversation.id,
  });
  return conversation.id;
};

const serve = (approved: boolean) =>
  stubFetch((url) => {
    if (url.includes('/messages')) {
      return new Response(JSON.stringify(TRANSCRIPT), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/plan')) {
      return new Response(JSON.stringify(planStatus(approved)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ detail: 'not found' }), { status: 404 });
  });

let restore: (() => void) | null = null;

const renderShell = (conversationId: string) =>
  render(
    <MemoryRouter>
      <AuthGate>
        <AppShell conversationId={conversationId} />
      </AuthGate>
    </MemoryRouter>,
  );

beforeEach(() => {
  cleanup();
  useChatStore.setState({
    conversations: {},
    order: [],
    activeId: null,
    drafts: {},
    composerLock: false,
    banner: null,
    jobFeed: [],
    streaming: null,
  });
});

afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

describe('a plan awaiting a decision, after a reload', () => {
  it('offers the decision again instead of leaving the session silently blocked', async () => {
    const stub = serve(false);
    restore = stub.restore;

    renderShell(seed());

    // The card is back, and it is the real one: an Approve control, not a note saying a decision
    // is pending somewhere else.
    expect(await screen.findByRole('button', { name: /approve plan/i })).toBeTruthy();
    // The plan came back through `PlanItems`, so the checkbox prefix is parsed rather than printed.
    expect(screen.getAllByText('Run xTB on the aryl bromide').length).toBeGreaterThan(0);
    expect(screen.queryByText(/^\[[x ]\]/)).toBeNull();
  });

  it('says nothing when the plan already holds a live approval', async () => {
    // The negative half, and it is what keeps the card a *signal*. Attaching it whenever a plan
    // exists would put an Approve button on every rehydrated conversation in the app, which is the
    // same "a control that reads as real" failure in the other direction.
    const stub = serve(true);
    restore = stub.restore;

    renderShell(seed());

    expect(await screen.findByText('Here is what I propose.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /approve plan/i })).toBeNull();
  });

  it('does not stack a second card when the rehydrate runs again', async () => {
    const stub = serve(false);
    restore = stub.restore;
    const cid = seed();

    const { unmount } = renderShell(cid);
    await screen.findByRole('button', { name: /approve plan/i });
    unmount();
    // The effect re-fires on `messageCount`, so a conversation can be rehydrated more than once in
    // one session. Two Approve buttons on one message would be two decisions about one plan.
    renderShell(cid);

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /approve plan/i })).toHaveLength(1),
    );
  });
});
