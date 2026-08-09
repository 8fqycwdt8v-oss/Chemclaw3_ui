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

const TRANSCRIPT = [
  { index: 0, role: 'user', text: 'What did we decide about the ligand?', tool_calls: [] },
  {
    index: 1,
    role: 'assistant',
    text: 'BrettPhos, at 1.2 equiv base.',
    // The service sends these on every message. The client's type did not declare them, so a
    // transcript read back from the server used to arrive with the agent's work stripped out.
    tool_calls: [
      { tool: 'gather_evidence', arguments: '{"query":"BrettPhos"}', result: '3 notes' },
      { tool: 'predict_pka', arguments: '{"smiles":"CCO"}', result: null },
    ],
  },
];

/** A conversation with a session and no messages — the shape both cases share. */
const seed = (sessionOrigin: 'local' | 'server') => {
  const conversation = { ...newConversation(), sessionId: SID, sessionOrigin };
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

  it('rebuilds the agent’s work from the tool calls the transcript carries', async () => {
    const stub = stubFetch((url) =>
      url.includes('/messages')
        ? new Response(JSON.stringify(TRANSCRIPT), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : new Response(JSON.stringify({ detail: 'not found' }), { status: 404 }),
    );
    restore = stub.restore;

    const cid = seed('server');
    renderShell(cid);
    await screen.findByText('BrettPhos, at 1.2 equiv base.');

    const assistant = useChatStore
      .getState()
      .conversations[cid]?.messages.find((m) => m.role === 'assistant');
    if (assistant?.role !== 'assistant') throw new Error('no assistant message');

    expect(assistant.trace.map((e) => e.toolCall?.tool)).toEqual([
      'gather_evidence',
      'predict_pka',
    ]);
    // A transcript is written after the turn, so no call in it can still be running. A stored
    // `result` of null means the call raised — which is `failed`, not "returned nothing".
    expect(assistant.trace[0]?.toolCall?.result).toBe('3 notes');
    expect(assistant.trace[1]?.toolCall?.failed).toBe(true);
    expect(assistant.trace[1]?.toolCall?.result).toBeUndefined();
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
});
