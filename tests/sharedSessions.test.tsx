/**
 * Shared sessions (Chemclaw3 #483, `D-2026-09-27-in-a-shared-session-the-sender-governs`).
 *
 * The owner admits members; a member reads and sends, and every message runs as its sender; only a
 * plan's author decides on it; deleting, branching and stopping somebody else's turn stay the
 * owner's. The service enforces every one of those. What is pinned here is the client's half: that
 * it asks the right routes with the id encoded, that it does not offer a control whose only answer
 * is a 403, that a 403 which comes anyway reads as the rule it is, and that a shared transcript
 * says whose each question was.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { api, type PlanStatus } from '../src/api/client.ts';
import { queryClient } from '../src/api/queryClient.ts';
import { ApprovalPrompt, planDecisionLock } from '../src/components/Prompts.tsx';
import { senderOf } from '../src/components/MessageList.tsx';
import { MembersPanel } from '../src/components/MembersPanel.tsx';
import { SidebarBody, adoptShared } from '../src/components/Sidebar.tsx';
import { newConversation, useChatStore } from '../src/state/chatStore.ts';
import { transcriptToMessages } from '../src/state/transcript.ts';
import { sendMessage } from '../src/state/sendMessage.ts';
import type { ChatMessage } from '../src/state/types.ts';
import { stubFetch } from './helpers.ts';

/** Who is reading, as the auth mock below and the store's `viewer` both say. */
const ME = 'oid-me';
const OWNER = 'oid-owner';
const SID = 'c'.repeat(32);

vi.mock('../src/auth/AuthContext.tsx', () => {
  const value = {
    auth: {
      mode: 'msal',
      account: { id: 'oid-me', username: 'me@example.com', name: 'Me', roles: [] },
      getAccessToken: async () => 'token',
      handleUnauthorized: async () => false,
    },
    ready: true,
  };
  return { useAuth: () => value, useIsReviewer: () => true };
});

const json = (status: number, body: unknown): Response =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

let restore: (() => void) | null = null;

beforeEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
  useChatStore.setState({
    viewer: ME,
    conversations: {},
    order: [],
    activeId: null,
    drafts: {},
    banner: null,
    streaming: null,
  });
});

afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

/** A conversation in the store, bound to `SID`, optionally somebody else's. */
function seed(membership?: { owner: string | null }): string {
  const conversation = {
    ...newConversation(),
    sessionId: SID,
    title: 'Amination work-up',
    sessionOrigin: 'server' as const,
    ...(membership ? { membership } : {}),
  };
  useChatStore.setState((s) => ({
    conversations: { ...s.conversations, [conversation.id]: conversation },
    order: [...s.order, conversation.id],
  }));
  return conversation.id;
}

describe('the member routes, as this client asks them', () => {
  it('encodes the actor id into its path segment', async () => {
    const stub = stubFetch(() => json(204, null));
    restore = stub.restore;
    await api.addMember(SID, 'user/../x y', async () => null);
    await api.removeMember(SID, 'a@b', async () => null);
    expect(stub.calls[0]?.url).toBe(`/api/sessions/${SID}/members/user%2F..%2Fx%20y`);
    expect(stub.calls[0]?.init?.method).toBe('PUT');
    expect(stub.calls[1]?.url).toBe(`/api/sessions/${SID}/members/a%40b`);
    expect(stub.calls[1]?.init?.method).toBe('DELETE');
  });

  it('degrades the shared listing to nothing on a service without the route', async () => {
    const stub = stubFetch(() => json(404, { detail: 'Not Found' }));
    restore = stub.restore;
    await expect(api.listSharedSessions(async () => null)).resolves.toEqual([]);
    expect(stub.calls[0]?.url).toBe('/api/sessions/shared');
  });

  it('does not swallow a roster read that failed', async () => {
    const stub = stubFetch(() => json(404, { detail: 'unknown session' }));
    restore = stub.restore;
    await expect(api.listMembers(SID, async () => null)).rejects.toMatchObject({
      kind: 'session_not_found',
    });
  });
});

describe('whose words each question is', () => {
  it('carries the sender of a stored user message', () => {
    const messages = transcriptToMessages([
      { index: 0, role: 'user', text: 'Owner asks', tool_calls: [], author: { actor: OWNER } },
      {
        index: 1,
        role: 'assistant',
        text: 'Answer',
        tool_calls: [],
        author: { actor: OWNER, agent: 'chemclaw' },
      },
      { index: 2, role: 'user', text: 'Member asks', tool_calls: [], author: null },
    ]);
    expect(messages[0]).toMatchObject({ role: 'user', author: OWNER });
    expect(messages[2]).not.toHaveProperty('author');
  });

  it('labels every question in a shared conversation, the reader’s own as "You"', () => {
    const theirs: ChatMessage = { id: '1', role: 'user', text: 'q', at: 0, author: OWNER };
    const mine: ChatMessage = { id: '2', role: 'user', text: 'q', at: 0, author: ME };
    const live: ChatMessage = { id: '3', role: 'user', text: 'q', at: 0 };
    expect(senderOf(theirs, true, ME)).toBe(OWNER);
    expect(senderOf(mine, true, ME)).toBe('You');
    expect(senderOf(live, true, ME)).toBe('You');
    // Nobody else here: no labels at all, rather than a "You" on every bubble.
    expect(senderOf(theirs, false, ME)).toBeUndefined();
  });
});

describe('who may decide on a plan', () => {
  it('is its author, when the service names one', () => {
    expect(planDecisionLock(ME, ME, undefined)).toBeNull();
    expect(planDecisionLock(OWNER, ME, { owner: OWNER })).toMatch(/Only oid-owner can approve/);
  });

  it('is the owner when no author is recorded, so a member may not', () => {
    expect(planDecisionLock(null, ME, undefined)).toBeNull();
    expect(planDecisionLock(null, ME, { owner: OWNER })).toMatch(/owner, oid-owner/);
  });

  it('is this reader when nobody asked — a plan streamed into their own turn', () => {
    expect(planDecisionLock(undefined, ME, { owner: OWNER })).toBeNull();
  });

  const status = (author: string | null): PlanStatus => ({
    session_id: SID,
    plan_hash: 'h1',
    plan: ['Charge the flask'],
    scope: [],
    mode: 'plan_only',
    approved: false,
    decided_by: null,
    author,
  });

  it('shows another member’s plan with its author and the controls disabled', async () => {
    seed({ owner: OWNER });
    vi.spyOn(api, 'getPlan').mockResolvedValue(status(OWNER));
    const decide = vi.spyOn(api, 'decidePlan');
    render(<ApprovalPrompt prompt="Approve?" sessionId={SID} />);

    expect(await screen.findByText(/Proposed in answer to/)).toBeTruthy();
    const approve = screen.getByRole('button', { name: /approve plan/i });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    // The reason is the button's description, not a sentence floating near it.
    const described = approve.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(described)?.textContent).toMatch(/Only oid-owner/);
    expect(decide).not.toHaveBeenCalled();
  });

  it('leaves the reader’s own plan decidable', async () => {
    seed({ owner: OWNER });
    vi.spyOn(api, 'getPlan').mockResolvedValue(status(ME));
    render(<ApprovalPrompt prompt="Approve?" sessionId={SID} />);
    const approve = await screen.findByRole('button', { name: /approve plan/i });
    expect((approve as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/your message/)).toBeTruthy();
  });

  it('locks the card with the service’s sentence when the decision is refused anyway', async () => {
    vi.spyOn(api, 'getPlan').mockResolvedValue(status(ME));
    const stub = stubFetch(() =>
      json(403, { detail: 'only the person whose message produced this plan may decide on it' }),
    );
    restore = stub.restore;
    render(<ApprovalPrompt prompt="Approve?" sessionId={SID} />);
    fireEvent.click(await screen.findByRole('button', { name: /approve plan/i }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /approve plan/i }));

    expect(
      await screen.findByText(/only the person whose message produced this plan/),
    ).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /approve plan/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('the sidebar', () => {
  const mount = (): void => {
    render(
      <MemoryRouter>
        <SidebarBody />
      </MemoryRouter>,
    );
  };

  it('lists conversations shared with this person under their own heading', async () => {
    const stub = stubFetch((url) =>
      url.includes('/sessions/shared')
        ? json(200, [
            {
              session_id: SID,
              owner: OWNER,
              title: 'Their screen',
              added_at: '2026-09-27T10:00:00Z',
            },
          ])
        : json(200, []),
    );
    restore = stub.restore;
    mount();

    const shared = await screen.findByRole('list', { name: 'Shared with me' });
    expect(within(shared).getByText('Their screen')).toBeTruthy();
    expect(within(shared).getByText(/from oid-owner/)).toBeTruthy();
  });

  it('offers a member Leave, and neither Branch nor Delete', async () => {
    restore = stubFetch(() => json(200, [])).restore;
    seed({ owner: OWNER });
    mount();

    fireEvent.pointerDown(
      await screen.findByRole('button', { name: /Actions for Amination work-up/ }),
      { button: 0, ctrlKey: false },
    );
    expect(await screen.findByRole('menuitem', { name: /Leave conversation/ })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /Branch/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Delete/ })).toBeNull();
  });

  it('marks a conversation it already holds rather than adding a second', () => {
    const id = seed();
    adoptShared([{ session_id: SID, owner: OWNER, title: null, added_at: '2026-09-27T10:00:00Z' }]);
    const state = useChatStore.getState();
    expect(state.order).toEqual([id]);
    expect(state.conversations[id]?.membership).toEqual({ owner: OWNER });
  });
});

describe('the people panel', () => {
  const roster = (owner: string, members: string[]) => ({
    owner,
    members: members.map((actor) => ({ actor, added_at: '2026-09-27T10:00:00Z' })),
  });

  const mount = (id: string): void => {
    render(
      <MemoryRouter>
        <MembersPanel conversationId={id} />
      </MemoryRouter>,
    );
  };

  it('lets the owner add somebody by id, encoded, and says the service’s refusal', async () => {
    const stub = stubFetch((url, init) => {
      if (init?.method === 'PUT' && url.endsWith('/members/oid-owner')) {
        return json(409, { detail: 'the owner is not a member of their session' });
      }
      if (init?.method === 'PUT') return json(204, null);
      return json(200, roster(ME, []));
    });
    restore = stub.restore;
    mount(seed());

    const input = await screen.findByLabelText(/Add a person by their account id/);
    fireEvent.change(input, { target: { value: 'oid colleague' } });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    await waitFor(() =>
      expect(stub.calls.some((c) => c.url.endsWith('/members/oid%20colleague'))).toBe(true),
    );

    fireEvent.change(input, { target: { value: OWNER } });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'the owner is not a member of their session',
    );
  });

  it('shows a member the owner, no add control, and a way to leave', async () => {
    const stub = stubFetch((_url, init) =>
      init?.method === 'DELETE' ? json(204, null) : json(200, roster(OWNER, [ME])),
    );
    restore = stub.restore;
    const id = seed({ owner: OWNER });
    mount(id);

    expect(await screen.findByText(OWNER)).toBeTruthy();
    expect(screen.queryByLabelText(/Add a person/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Leave this conversation/ }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave' }));

    await waitFor(() => expect(useChatStore.getState().conversations[id]).toBeUndefined());
    const leave = stub.calls.find((c) => c.init?.method === 'DELETE');
    expect(leave?.url).toBe(`/api/sessions/${SID}/members/${ME}`);
  });

  it('corrects the store when the roster says this person owns it', async () => {
    restore = stubFetch(() => json(200, roster(ME, []))).restore;
    const id = seed({ owner: OWNER });
    mount(id);
    await waitFor(() =>
      expect(useChatStore.getState().conversations[id]?.membership).toBeUndefined(),
    );
  });
});

describe('sending into a conversation somebody else owns', () => {
  const auth = {
    mode: 'dev' as const,
    account: null,
    getAccessToken: async () => null,
    login: async () => undefined,
    logout: async () => undefined,
    handleUnauthorized: async () => false,
  };

  it('does not move a removed member’s question into a private replacement session', async () => {
    // Everywhere else a 404 mints a new session and replays once. Here it means the owner removed
    // this person, and a replacement would be a session nobody else is in, under the shared title.
    const stub = stubFetch(() => json(404, { detail: 'unknown session' }));
    restore = stub.restore;
    const id = seed({ owner: OWNER });
    await sendMessage({ conversationId: id, text: 'still here?', auth });

    expect(stub.calls.some((c) => c.init?.method === 'POST' && c.url.endsWith('/sessions'))).toBe(
      false,
    );
    expect(useChatStore.getState().conversations[id]?.sessionId).toBe(SID);
    const banner = useChatStore.getState().banner;
    expect(banner?.text).toMatch(/no longer have access to this shared conversation/);
    // And no "start a fresh session", which would leave the shared conversation just the same.
    expect(banner?.action).toBeUndefined();
  });

  it('offers a retry, not a reset, when somebody else’s turn is running', async () => {
    restore = stubFetch(() => json(409, { detail: 'a turn is already running' })).restore;
    const id = seed({ owner: OWNER });
    await sendMessage({ conversationId: id, text: 'next', auth });
    expect(useChatStore.getState().banner?.action).toBe('retry');
  });
});
