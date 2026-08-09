/**
 * Pulling a transcript the server has but this browser does not.
 *
 * The guard is `sessionOrigin === 'server'`, and it is load-bearing rather than tidy. Warming
 * gives a brand-new local conversation a session id before its first message — which is exactly
 * "has a session, has no messages", the other half of this effect's condition. Without the origin
 * check, every warmed conversation would fire a `GET /messages` for a session created milliseconds
 * earlier, and a 401 or a 500 would raise a warn banner on a conversation nobody has used yet.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { useChatStore, newConversation } from '../src/state/chatStore.ts';
import { AuthGate } from '../src/auth/AuthContext.tsx';
import { AppShell } from '../src/App.tsx';
import { stubFetch } from './helpers.ts';

const SID = 'a'.repeat(32);

/** Exactly the shape `GET /sessions/{id}/messages` returns — index, text and what it did. */
const TRANSCRIPT = [
  { index: 0, role: 'user', text: 'What did we decide about the ligand?', tool_calls: [] },
  {
    index: 1,
    role: 'assistant',
    text: 'BrettPhos, at 1.2 equiv base.',
    tool_calls: [
      { tool: 'search_notes', arguments: '{"q":"ligand"}', result: 'Note eln-4471.' },
      { tool: 'screen_hazards', arguments: '{"smiles":"CCO"}', result: null },
    ],
  },
];

/** A conversation with a session and no messages — the shape both cases share. */
const seed = (sessionOrigin: 'local' | 'server') => {
  const conversation = {
    ...newConversation(),
    sessionId: SID,
    sessionOrigin,
    // What the sidebar's stub carries for a session it learned about from `GET /sessions`, which
    // returns no title of any kind.
    title: sessionOrigin === 'server' ? 'Earlier conversation' : 'New conversation',
  };
  useChatStore.setState({
    conversations: { [conversation.id]: conversation },
    order: [conversation.id],
    activeId: conversation.id,
  });
  return conversation.id;
};

let restore: (() => void) | null = null;

const renderShell = (conversationId: string) =>
  render(
    <MemoryRouter>
      <AuthGate>
        <AppShell conversationId={conversationId} />
      </AuthGate>
    </MemoryRouter>,
  );

/** Only the transcript read, not the health poll or the session list. */
const transcriptReads = (calls: { url: string; init?: RequestInit }[]) =>
  calls.filter((c) => c.url.includes(`/sessions/${SID}/messages`) && c.init?.method !== 'POST');

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

describe('transcript rehydrate', () => {
  it('reads the messages of a session that came from the server', async () => {
    const stub = stubFetch((url) =>
      url.includes('/messages')
        ? new Response(JSON.stringify(TRANSCRIPT), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : new Response(JSON.stringify({ detail: 'not found' }), { status: 404 }),
    );
    restore = stub.restore;

    renderShell(seed('server'));

    expect(await screen.findByText('BrettPhos, at 1.2 equiv base.')).toBeTruthy();
  });

  it('does not read the messages of a session this browser just warmed', async () => {
    const stub = stubFetch(
      () => new Response(JSON.stringify({ detail: 'not found' }), { status: 404 }),
    );
    restore = stub.restore;

    renderShell(seed('local'));

    // Give the effect every chance to fire before concluding it did not.
    await waitFor(() => expect(stub.calls.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));

    expect(transcriptReads(stub.calls)).toHaveLength(0);
    // And no banner, which is the part the chemist would actually have seen.
    expect(useChatStore.getState().banner).toBeNull();
  });

  it('says so when the read fails, rather than showing an empty conversation', async () => {
    // `getMessages` swallows only `session_not_found`. A 500 used to surface as a blank transcript
    // with no way to tell "nothing was said yet" from "we could not load it".
    const stub = stubFetch((url) =>
      url.includes('/messages')
        ? new Response(JSON.stringify({ detail: 'boom' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        : new Response(JSON.stringify({ detail: 'not found' }), { status: 404 }),
    );
    restore = stub.restore;

    renderShell(seed('server'));

    await waitFor(() => expect(useChatStore.getState().banner?.kind).toBe('warn'));
    expect(useChatStore.getState().banner?.action).toBe('retry');
  });

  it('restores what the agent did, not only what it said', async () => {
    // The service persists each message's tool calls and serves them back; this client used to
    // hardcode `trace: []`, so a reload rendered the prose and lost every step behind it.
    const stub = stubFetch((url) =>
      url.includes('/messages')
        ? new Response(JSON.stringify(TRANSCRIPT), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : new Response(JSON.stringify({ detail: 'not found' }), { status: 404 }),
    );
    restore = stub.restore;

    const id = seed('server');
    renderShell(id);

    await screen.findByText('BrettPhos, at 1.2 equiv base.');
    const conversation = useChatStore.getState().conversations[id];
    const answer = conversation?.messages.find((m) => m.role === 'assistant');
    expect(answer?.role === 'assistant' ? answer.trace : []).toHaveLength(2);

    // And the disclosure that fronts it counts them, so the trace is reachable and not merely
    // present in the store.
    expect(
      await screen.findByRole('button', { name: /Show the agent’s work \(2 steps\)/ }),
    ).toBeTruthy();
  });

  it('names a restored conversation after what was actually asked in it', async () => {
    // `GET /sessions` is `{session_id, created_at}` — no title, because the server mints a session
    // before anyone has spoken. Every conversation restored from another device therefore arrived
    // as "Earlier conversation", and a week of history was a list of identical rows.
    const stub = stubFetch((url) =>
      url.includes('/messages')
        ? new Response(JSON.stringify(TRANSCRIPT), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : new Response(JSON.stringify({ detail: 'not found' }), { status: 404 }),
    );
    restore = stub.restore;

    const id = seed('server');
    renderShell(id);

    await waitFor(() =>
      expect(useChatStore.getState().conversations[id]?.title).toBe(
        'What did we decide about the ligand?',
      ),
    );
  });
});
