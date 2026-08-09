/**
 * The two workbench pieces whose value is entirely in being *connected* to something.
 *
 * `api.listApprovals` and `api.decideApproval` have existed in this client for a while and no view
 * has ever called them — the same dead end the backend route was added to close, one layer up: a
 * hold nobody can find can only time out, silently dropping the knowledge write it was holding. So
 * the assertion worth making is that a click on the inbox reaches the decision route, with the
 * hold's own id.
 *
 * And the profile picker exists to make `SessionIn.profile` reachable. The extension has to be
 * *compatible*: `createSession` is the call every conversation depends on and has always been made
 * bodyless, so the no-profile case must still send no body at all.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApprovalsView } from '../src/views/ApprovalsView.tsx';
import { ProfilePicker } from '../src/views/ProfilePicker.tsx';
import { api } from '../src/api/client.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import { config } from '../src/env.ts';
import { stubFetch } from './helpers.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => 'token' } }),
}));

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useChatStore.setState({ conversations: {}, order: [], activeId: null });
});

describe('approvals inbox', () => {
  it('answers a hold on the decision route, with the hold’s own id', async () => {
    vi.spyOn(api, 'listApprovals').mockResolvedValue([
      {
        approval_id: 'approval-Suzuki(A)',
        question: 'Record 4-bromoanisole as an aryl halide?',
        requested_by: 'chemist@example.com',
      },
    ]);
    const decide = vi.spyOn(api, 'decideApproval').mockResolvedValue();
    render(<ApprovalsView />);

    fireEvent.click(await screen.findByText('Approve'));

    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(decide.mock.calls[0]?.slice(0, 2)).toEqual(['approval-Suzuki(A)', true]);
  });

  it('renders the question the hold is asking, not just its id', async () => {
    vi.spyOn(api, 'listApprovals').mockResolvedValue([
      { approval_id: 'approval-7', question: 'Record 4-bromoanisole as an aryl halide?' },
    ]);
    render(<ApprovalsView />);

    expect(await screen.findByText('Record 4-bromoanisole as an aryl halide?')).toBeTruthy();
  });

  it('distinguishes "nothing is waiting" from "we could not find out"', async () => {
    vi.spyOn(api, 'listApprovals').mockResolvedValue([]);
    render(<ApprovalsView />);

    expect(await screen.findByText('Nothing is waiting on you.')).toBeTruthy();
  });
});

describe('profile picker', () => {
  it('creates the session itself, so the turn orchestrator does not mint a profile-less one', async () => {
    // `ensureSession` creates a session on the first message with no profile and cannot be told
    // about a choice made here. Writing the session id into the conversation is what makes it
    // find one already there.
    vi.spyOn(api, 'listProfiles').mockResolvedValue(['property-lookup']);
    const create = vi.spyOn(api, 'createSession').mockResolvedValue({ session_id: 'c'.repeat(32) });
    const conversationId = useChatStore.getState().createConversation();

    render(<ProfilePicker conversationId={conversationId} sessionId={null} />);
    fireEvent.click(await screen.findByText('property-lookup'));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]?.[1]).toBe('property-lookup');
    await waitFor(() =>
      expect(useChatStore.getState().conversations[conversationId]?.sessionId).toBe('c'.repeat(32)),
    );
  });

  it('says nothing about a session whose profile this browser did not choose', async () => {
    // The backend does not report a session's profile, so after a reload the honest answer is
    // silence — not a guess at "general".
    vi.spyOn(api, 'listProfiles').mockResolvedValue(['property-lookup']);
    const { container } = render(
      <ProfilePicker conversationId="conv-1" sessionId={'d'.repeat(32)} />,
    );

    await waitFor(() => expect(container.textContent).toBe(''));
  });
});

describe('createSession stays bodyless without a profile', () => {
  it('sends no body when none was asked for, and a profile body when one was', async () => {
    const stub = stubFetch(() => new Response('{"session_id":"x"}', { status: 200 }));
    try {
      await api.createSession(async () => 'token');
      await api.createSession(async () => 'token', 'property-lookup');
    } finally {
      stub.restore();
    }

    expect(stub.calls[0]?.url).toBe(`${config.apiBase}/sessions`);
    expect(stub.calls[0]?.init?.body).toBeUndefined();
    // No body means no content-type either: the request is byte-for-byte the one that has always
    // worked on this route.
    expect((stub.calls[0]?.init?.headers as Record<string, string>)['content-type']).toBeUndefined();
    expect(stub.calls[1]?.init?.body).toBe('{"profile":"property-lookup"}');
  });
});
